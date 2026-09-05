<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-storage: Shared Durable Sessions

## Intent

This package owns the portable session format, local provider hints and shared lifecycle used by interactive, headless and embedding hosts under [DR-049](../decisions/049-portable-session-contract.md).
It retains the frozen replay envelope and repository-effect authority while making neither a provider conversation nor an application-specific project registry necessary for history.

## External Behavior

### session-storage-1

The session store shall use `${SPEX_HOME:-$HOME/.spex}/sessions` by default, honoring the shared config's `sessions` locator and explicit injected-store precedence [[playbook-cli-78](playbook-cli.md#playbook-cli-78)], with these files per canonical lowercase UUID:

| File | Contents | Portability |
| --- | --- | --- |
| `<id>.json` | Manifest [[session-storage-2](#session-storage-2)] | Portable |
| `<id>.records.jsonl` | Replay [[session-storage-3](#session-storage-3)] | Portable with manifest |
| `<id>.hints.json` | Provider hints [[session-storage-6](#session-storage-6)] | Local, ignored by Git |
| `.<id>.lock/` and its staging/retired directories | Existing writer lease [[playbook-cli-23](playbook-cli.md#playbook-cli-23)] | Local, ignored by Git |

- manifests and hints use the same private regular-file and atomic publication rules as replay [[playbook-cli-74](playbook-cli.md#playbook-cli-74)]; neither symlinks nor unsafe modes are repaired by weakening the boundary.
- both hosts record the normalized absolute `cwd`; no Spex project ID or registry access participates in the format.

### session-storage-2

The store shall encode a manifest as a closed schema-version-7 JSON object with these common fields and exactly one state variant:

| Field | Content |
| --- | --- |
| `schemaVersion`, `kind` | `7`, `"captain-session"` |
| `sessionId`, `cwd` | Canonical UUID matching the filename; normalized absolute working directory |
| `createdAt`, `updatedAt` | Canonical ISO UTC timestamps; creation fixed, forward updates strictly increase |
| `replay` | Exactly `{seq,sha256,incomplete}` under the checkpoint rule [[session-storage-4](#session-storage-4)] |
| `contextSeq` | Positive safe integer no greater than `replay.seq`, naming the applicable context [[session-storage-5](#session-storage-5)]; `null` only in history-only state lacking context |
| `state: 'settled' \| 'uncertain'` | `structuralProjection`, `lastAppliedExecutionProjection`, `snapshot`, `effectLedger`, `unresolvedEffects`; optional `retainedGenerations` and `settledAbandonment`; `uncertain` present exactly in uncertain state |
| `state: 'history-only'` | Nonempty string `reason`; no executable recovery fields |

- executable fields retain the structural/execution projection, uncertainty, settlement, snapshot and ledger relationships of the durable Captain contract [[playbook-cli-23](playbook-cli.md#playbook-cli-23)], in their token-free storage form [[session-storage-7](#session-storage-7)]; state never implies lease ownership.
- unknown manifest or nested recovery versions remain byte-identical and permit only readable history and lease-checked deletion, never execution or silent downgrade.

### session-storage-3

Every host shall preserve the frozen v1 replay envelope and token-free sanitization [[playbook-cli-74](playbook-cli.md#playbook-cli-74)] [[playbook-cli-75](playbook-cli.md#playbook-cli-75)], counting valid opaque records in sequence and digest checks even when their kind or presentation header is unknown:

- only `v`, `seq`, optional string `role`, and object `record` are envelope members; `type` and `timestamp` are not required by v1;
- presentation skips an unsupported record without reporting damage; new context and reset kinds require their declared headers [[session-storage-5](#session-storage-5)] [[session-storage-8](#session-storage-8)];
- the shared lifecycle's history reader returns the complete valid newline-terminated prefix and report the first damaged boundary without modifying it; a torn final line waits for completion;
- new writers emit context kinds only after both host readers implement these rules.

### session-storage-4

When the shared lifecycle checkpoints a session, it shall bind recovery to an exact durable replay prefix as `{seq,sha256,incomplete}`, where `seq` is a nonnegative safe integer and `sha256` is lowercase hexadecimal SHA-256 of the exact UTF-8 bytes through that sequence's terminating LF:

- sequence zero hashes zero bytes; no JSON reserialization, whitespace normalization or line-ending conversion participates;
- replay is synchronized before publishing the manifest that names its prefix; later visible records cannot prove a newer recovery boundary;
- replay failure preserves the last proven prefix and sets `incomplete:true` in the next durable manifest while recovery/uncertainty remains independently durable;
- a digest mismatch, missing prefix, persisted incompleteness or unsupported required context refuses continuation while retaining readable history;
- a new lease cannot clear persisted incompleteness merely because today's bytes parse; only explicit validated migration/repair may establish a replacement checkpoint;
- release persists any newly latched incompleteness before retiring ownership; failure to persist it reports failure and retains ownership until safe recovery or process death;
- an inability to persist recovery before an external effect refuses that effect; failures after effects retain uncertain evidence and never authorize replay.

### session-storage-5

Before presenting events under a new execution configuration, the writer shall persist one immutable context record in replay with exactly `{type:'session_context',timestamp,contextVersion:1,captainId,configuration,graphs,initialVisible}`:

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

The hint store shall encode `<id>.hints.json` as exactly `{v:1,sessionId,checkpointSha256,players,captain?}`, where `checkpointSha256` hashes the exact published portable manifest bytes, `players` maps current player IDs to nonempty token strings, and optional `captain` is the original pinned or catch-up conversation value [[playbook-captain-41](playbook-captain.md#playbook-captain-41)]:

- unknown participants, mismatched session/digest, invalid shapes, missing files and unreadable hints mean no continuity; they do not invalidate portable history;
- hints attach only to the current checkpoint, never to retained generations, a restored older manifest or a different participant;
- before using a hint, the lease owner durably removes that participant's hint, so a crash after the provider advances cannot reuse it against the old checkpoint;
- new hints are published only after their resulting portable checkpoint, from an acknowledged continuation or proven pre-execution retention; a consumed pre-call token surviving in memory is insufficient, and failed hint writes fall back to fresh continuity;
- hints are excluded from replay, portable manifests and Git; copying a session bundle copies neither hints nor leases.

### session-storage-7

When serializing recovery, the store shall produce its token-free storage form by applying these schema-aware transformations to the current checkpoint, retained generations and every nested snapshot/ledger copy:

| Location | Portable form |
| --- | --- |
| Captain conversation | `unopened` for empty history; otherwise `needsSeeding` |
| Player ledger `resumeToken` | Omitted; fixed participant/settings identity retained |
| Runtime `roleResumeTokens` | Empty map; role bindings retained |
| Deferred logical operation `playerContinuation` | Exactly `{v:1,playerId}` naming the bound player, with operation/checkpoint/question/receipts unchanged [[playbook-runtime-73](playbook-runtime.md#playbook-runtime-73)] |
| Known observed/recovery payload token fields | Removed by the shared sanitizer [[playbook-cli-75](playbook-cli.md#playbook-cli-75)] |

- all copies of a ledger and all aliased role views agree after projection; logical operation IDs and effect receipts are never replaced by provider tokens;
- current participant hints may restore current Captain/player continuity in memory; role views derive from that current player ledger, and retained tokens are never reinstated;
- an unknown binding shape or an ambiguous deferred player identity is unsupported recovery, not permission to erase arbitrary JSON and claim resumability;
- ordinary instructions, prompts and tool content remain history; token-free means no structured provider-continuation fields, not secret detection in user-authored text.

### session-storage-8

When a provider hint is absent or definitively rejected before execution, the host shall start a fresh conversation for the same logical call using Captain's full recovery journal or the player's complete task and pending Q+A, with the existing operation identity and effect authority:

- a rejected hint permits exactly one fresh attempt only on Cligent's `SESSION_RESUME_REJECTED` classification [[1]]; unrelated errors, timeouts and ambiguous execution never take this path;
- the reset emits `{type:'continuity_reset',timestamp,contextSeq,participantId,reason}`, with finite timestamp and reason `missing_hint` or `rejected_hint`, without the token;
- a second failure uses ordinary failure/uncertainty handling, and the reset never repeats already acknowledged actions;
- provider-only knowledge is unavailable; the host must not claim to restore it from the session store.

### session-storage-9

When opening a portable checkpoint on another device, the lifecycle shall require its recorded working directory, canonical module locators and repository/effect identities to match the destination's validated execution context before continuation:

- this format authorizes no rewriting of repository/module paths inside checkpoints, opaque snapshots or effect receipts; changed paths permit history only;
- an application path alias changes listing identity only; it cannot satisfy an execution mismatch;
- matching paths still require compatible runtimes, exact structural validation and ordinary repository/effect reconciliation;
- adding supported checkpoint relocation requires a subsequent versioned contract, not string substitution by a host.

### session-storage-10

When migrating a stopped legacy store, the shared migrator shall hold the session lease and preserve source bytes outside the portable namespace before publishing a validated schema-7 bundle:

- supported schema-6 recovery is validated with its legacy codec, then projected and revalidated with the current codec under the token-free rule [[session-storage-7](#session-storage-7)] without losing uncertainty, journals, counters, retained generations or effect evidence;
- legacy tokens are discarded as usable hints, since the old format cannot prove the provider still matches that checkpoint; original inputs remain ignored;
- schema 2–5 and desktop sidecars lacking complete durable recovery produce history-only manifests, retaining their replay or journal-derived history and explaining the missing authority;
- missing historical context remains missing; current validated context may be appended for a supported checkpoint without assigning it to earlier events;
- malformed inputs remain unchanged and reported; conflicting destination bytes refuse replacement; completed identical outputs make retries idempotent;
- old sidecar writers retire at cutover; ordinary opening does not silently downgrade unsupported recovery or clear an incomplete marker;
- no host tracks the migrated bundle in Git until token-free validation succeeds.

### session-storage-11

The published session-host capability shall offer embedding hosts the same create, open, begin-turn, settle, retry, discard, abandonment and release lifecycle used by both CLI front ends, backed by the same store, validators, writer leases and durable effect-ledger implementation [[playbook-cli-23](playbook-cli.md#playbook-cli-23)]:

- hosts supply agent calls, module loading, presentation and repository dependencies; they do not reimplement manifest writes, journal authority or recovery decisions;
- a create/open operation returns the logical session identity and a lease-bound lifecycle, while begin/settle/retry/discard/abandonment apply the existing state-machine preconditions and durable boundaries;
- release closes admission and drains earlier work before retiring ownership; an ended runtime does not fabricate a settled checkpoint;
- the existing summary/replay facade remains available; publishing a richer lifecycle does not expose hints through summary/history reads;
- the lifecycle also exposes the shared read-only validator and explicit migration/deletion operations, so management does not require executable playbook modules.

### session-storage-12

When a host requests session deletion, the shared store shall acquire provable exclusive ownership and remove replay, local hints, active legacy sidecar and derived session state before removing the manifest last:

- active or unprovable ownership refuses before deletion; retired lease guards remain against delayed reclaimers;
- interrupted cleanup is retryable, and partial bundles cannot continue;
- unknown recovery versions remain deletable by identity under the same lease without loading a module;
- deletion writes no tombstone and never removes a different session's files.

## Internal Behavior

### session-storage-13

The shared lifecycle shall use one version-aware codec for validation, projection, migration and hint attachment across all hosts, preserving unknown versions unchanged and rejecting mismatched mirrors before effects rather than allowing hosts to maintain independent format copies.

## Verification

### session-storage-14

When the integration suite creates, continues and deletes sessions through interactive, headless and embedding hosts against one real store, it shall verify common path/override resolution [[session-storage-1](#session-storage-1)], closed manifest variants [[session-storage-2](#session-storage-2)], shared lifecycle and leases [[session-storage-11](#session-storage-11)], deletion interruption/retry and retained guards [[session-storage-12](#session-storage-12)], and one codec across hosts [[session-storage-13](#session-storage-13)].

### session-storage-15

When the integration suite records Captain/player work and reopens it with modules removed, it shall verify opaque/headerless record tolerance [[session-storage-3](#session-storage-3)], byte-prefix digest checks and persistent incompleteness under injected write failures [[session-storage-4](#session-storage-4)], and graph/settings history from referenced context, including unknown versions and legacy missing graphs [[session-storage-5](#session-storage-5)].

### session-storage-16

When the integration suite checkpoints a session with current and retained player continuations and a deferred operation, it shall verify exact-checkpoint hints consumed before provider calls, stale-manifest rejection and crash fallback [[session-storage-6](#session-storage-6)], token-free current/nested/retained storage with unchanged logical/effect identities [[session-storage-7](#session-storage-7)], and one fresh attempt only for definite pre-execution rejection, with no replay on ambiguous failure [[session-storage-8](#session-storage-8)].

### session-storage-17

When the integration suite migrates legacy CLI/desktop fixtures and opens their copied bundles on another root, it shall verify unsupported-path history-only behavior and same-path reconciliation [[session-storage-9](#session-storage-9)], preserved source bytes, version/shape refusals, idempotent retries and token-free Git eligibility [[session-storage-10](#session-storage-10)].

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/packages/engine.md "Provider resume rejection classification"
