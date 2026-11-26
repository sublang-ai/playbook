<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-031: Shared Captain session front ends

## Status

Accepted.
Amends [DR-010](010-playbook-session-tracing-and-resume.md), [DR-015](015-per-run-agent-tuning.md), [DR-024](024-runtime-engine-provisioning.md).
Amended by [DR-032](032-explicit-roles-session-players.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-041](041-working-directory-aware-continuation.md), [DR-042](042-shared-session-store-and-replay-stream.md), [DR-049](049-portable-session-contract.md), [DR-073](073-durable-step-progress.md).

## Context

Interactive `playbook` hosts the compiled session Captain, its controller, the enabled-playbook catalog, the engagement stack, and mapped player continuity.
Released `playbook run` instead loads one registry directly, constructs a separate one-shot port host, reads a separate `run:` configuration section, and cannot execute a nested playbook call.
The same Boss text can therefore select different behavior solely because one front end has tmux and the other does not.
The one-shot snapshot can preserve one parked runtime, but it cannot preserve the Captain conversation or a parent suspended behind a nested child.

## Decision

### 1. One Captain session engine

Interactive `playbook` and headless `playbook run` shall host the same compiled session Captain, controller, enabled-playbook catalog, engagement stack, and mapped player sessions.
The front ends differ only in presentation: interactive mode attaches tmux panes, while headless mode observes the same host records without creating tmux.
The session Captain remains outside the working-playbook stack and is not disguised as a registry entry.

### 2. One configuration

A new headless session shall seed, migrate, overlay, validate, and resolve the same top-level `captain`, `players`, and `playbooks` configuration as an interactive session ([DR-032](032-explicit-roles-session-players.md)).
The separate top-level `run:` block and the run-only captain, player, and playbook-option overrides are retired.
Headless mode shall honor the resolved agent settings and playbook options while treating presentation-only layout, theme, and notification fields as inert.
Both front ends provision configured filesystem `playbooks.<id>.from` modules through this one launch path ([DR-024](024-runtime-engine-provisioning.md)), and both accept `--with` overlays ([DR-015](015-per-run-agent-tuning.md)).
Under [DR-032](032-explicit-roles-session-players.md), ordinary continuation shall retain the stored absolute working directory and structural projection while resolving current tuning, so a config edit cannot silently replace an active conversation or security envelope.

### 3. Equivalent Boss turns and replies

`playbook run [input]` shall create a logical Captain session and submit the exact argument text, or stdin when the argument is absent, through the same Boss-turn boundary as the Captain pane.
Registered commands, natural-language routing, validation, nested playbook calls, action settlement, recovery, and reply presentation shall therefore have the same semantics in both front ends.
Plain stdout shall contain exactly the one Boss-visible `captain_reply` accepted for that turn, buffered until the turn and its durable hand-off succeed.
Operational status and diagnostics shall use stderr, and JSON mode shall expose the session id and that same reply without exposing hidden control calls, player output, telemetry, or internal identifiers.

### 4. Durable complete sessions

A fresh launch through either front end shall create one public logical session id; a fresh interactive launch shall expose that id through operational output and atomically persist the initialized settled session in the shared session store ([DR-042](042-shared-session-store-and-replay-stream.md)) with user-only permissions before accepting Boss input.
Before agent work for every submitted non-empty turn in either front end, the host shall persist an uncertain write-ahead record, which also carries governed-call receipts, deferred-operation checkpoints, and unresolved-abandonment settlement ([DR-040](040-outcome-authority-effect-reconciliation.md)); after the turn settles, including chat and turns after a working playbook completes, it shall atomically persist the complete logical Captain session before presenting the reply.
The record shall contain the compiled Captain runtime snapshot, durable-conversation state and recovery journal, every engagement frame and runtime snapshot, pending nested-call identities, Captain-session player continuation ledger, counters, structural and attempted execution projections, and absolute working directory.
`playbook run --continue [reply]` shall select the newest resumable session stored for the invoking working directory, falling back explicitly to the globally newest ([DR-041](041-working-directory-aware-continuation.md)), while `--session <id>` shall select one explicitly; either shall read stdin when the reply is absent.
A per-session exclusive lock shall reject concurrent writers, and a crash after a turn starts but before its replacement snapshot is committed shall leave an explicit uncertain record rather than make the prior boundary silently replayable; reopening it restores the saved step position and reports before Boss chooses further work, never replaying a whole turn ([DR-073](073-durable-step-progress.md)).
Embedding hosts share this session lifecycle through Playbook's portable session contract ([DR-049](049-portable-session-contract.md)).

### 5. Suspended nested-call restoration

The runtime snapshot shall represent an already-started suspended nested call with its call id, source state, target playbook, exact handed-off text, child session id, and trace ownership.
Restoring that boundary shall reconnect the parent promise actor to the existing child frame without invoking `callPlaybook` again and without re-emitting the start boundary.
The eventual child result shall emit the one matching finish boundary and resume the restored parent exactly once.
Runtime snapshot schemas older than the player identity of [DR-032](032-explicit-roles-session-players.md) are rejected before binding rather than reinterpreted.

### 6. Public transition

The positional registry form `playbook run <from>`, `playbook run resume`, run-only binding flags, and the `run:` configuration block are removed.
An external playbook remains headlessly callable by enabling its registry in the shared config and sending its effective `/command` through Captain.
No separate direct-execution command is introduced by this decision.

### 7. Parked-session snapshot capability

The shared runtime contract shall carry an optional, paired `exportSnapshot`/`restore` capability, and a runtime shall implement both members or neither.
`exportSnapshot` shall return a JSON-safe snapshot only at a safe capture point — initialized, not disposing or disposed, no active public boundary, and the root actor quiescent — and `undefined` otherwise.
The snapshot shall carry its schema version, the playbook id, the XState persisted machine snapshot as an opaque JSON-safe value with raw `Error` values normalized to `{ name, message, stack? }`, the resume tokens, the sequence counters, the current state descriptor, and the pending Boss questions as a host-readable list, so a host shows the Boss what was asked without parsing status lines or telemetry.
`restore` is an alternative to `init` that binds the same immutable `PlaybookSession` identity, reconstructs the actor and its tokens and counters, emits no `session.started` trace, and continues the session's contiguous trace sequence.
The host shall recreate the runtime through the same factory with equivalent options and ports, and the runtime shall reject a snapshot whose schema version or playbook id it cannot rehydrate.
A host shall treat an absent `restore` as a playbook that cannot resume and fail with a diagnostic rather than silently start fresh.

### 8. A session may park across processes

Amends [DR-010](010-playbook-session-tracing-and-resume.md) §1: a playbook session is one logical lifecycle from its first `init` to its final settlement, and it may span host processes through export and restore segments.
A host that has persisted a parked snapshot may end its process without calling `dispose`; the parked session is suspended, not ended.
`session.disposed` marks the true session end — terminal completion, failure disposal, or deliberate abandonment — never a parked hand-off.

## Consequences

- A Boss turn has one orchestration meaning whether it enters through tmux or a shell pipeline.
- Headless CODE can call REVIEW through the real engagement stack instead of stopping at a synthetic suspended result.
- Cross-process continuation becomes a host-level Captain capability rather than a special case for one parked runtime.
- The nested runtime bridge, shared and bespoke linked runtimes, Captain shell, CLI, configuration, documentation, and release gates all require coordinated changes.
- The direct-run surface changed incompatibly, in a major version.
