<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-031: Shared Captain session front ends

## Status

Accepted.
[DR-032](032-explicit-roles-session-players.md) amends the shared configuration and durable record: active structure remains restorable, explicit session players and current model and effort replace the frozen namespaced lineup, and runtime snapshot schema `3` replaces schema `2` player identity.
[DR-040](040-outcome-authority-effect-reconciliation.md) extends the leased uncertain record with governed-call receipts, deferred-operation checkpoints, and unresolved-abandonment settlement, while permitting whole-turn retry only after every started boundary durably proves `unchanged`.

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

A new headless session shall seed, migrate, overlay, validate, and resolve the same top-level `captain` and `playbooks` configuration as an interactive session.
The separate top-level `run:` block and the run-only captain, player, and playbook-option overrides are retired.
Headless mode shall honor the resolved agent settings and playbook options while treating presentation-only layout, theme, and notification fields as inert.
Under [DR-032](032-explicit-roles-session-players.md), ordinary continuation shall retain the stored absolute working directory and structural projection while resolving current model and effort, so a config edit cannot silently replace an active conversation or security envelope.

### 3. Equivalent Boss turns and replies

`playbook run [input]` shall create a logical Captain session and submit the exact argument text, or stdin when the argument is absent, through the same Boss-turn boundary as the Captain pane.
Registered commands, natural-language routing, validation, nested playbook calls, action settlement, recovery, and reply presentation shall therefore have the same semantics in both front ends.
Plain stdout shall contain exactly the one Boss-visible `captain_reply` accepted for that turn, buffered until the turn and its durable hand-off succeed.
Operational status and diagnostics shall use stderr, and JSON mode shall expose the session id and that same reply without exposing hidden control calls, player output, telemetry, or internal identifiers.

### 4. Durable complete sessions

A fresh launch through either front end shall create one public logical session id; a fresh interactive launch shall expose that id through operational output and atomically persist the initialized settled session under the XDG state directory with user-only permissions before accepting Boss input.
Before agent work for every submitted non-empty turn in either front end, the host shall persist an uncertain write-ahead record; after the turn settles, including chat and turns after a working playbook completes, it shall atomically persist the complete logical Captain session before presenting the reply.
The record shall contain the compiled Captain runtime snapshot, durable-conversation state and recovery journal, every engagement frame and runtime snapshot, pending nested-call identities, Captain-session player continuation ledger, counters, structural and attempted execution projections, and absolute working directory.
`playbook run --continue [reply]` shall select the latest resumable session, while `--session <id>` shall select one explicitly; either shall read stdin when the reply is absent.
A per-session exclusive lock shall reject concurrent writers, and a crash after a turn starts but before its replacement snapshot is committed shall leave an explicit uncertain record rather than make the prior boundary silently replayable.

### 5. Suspended nested-call restoration

Runtime snapshot schema version 3 shall represent an already-started suspended nested call with its call id, source state, target playbook, exact handed-off text, child session id, and trace ownership.
Restoring that boundary shall reconnect the parent promise actor to the existing child frame without invoking `callPlaybook` again and without re-emitting the start boundary.
The eventual child result shall emit the one matching finish boundary and resume the restored parent exactly once.
Under [DR-032](032-explicit-roles-session-players.md), the next major shall reject runtime snapshot schemas `1` and `2` before binding rather than reinterpret their player identities.

### 6. Public transition

The positional registry form `playbook run <from>`, `playbook run resume`, run-only binding flags, and the `run:` configuration block are removed together in the next major release.
An external playbook remains headlessly callable by enabling its registry in the shared config and sending its effective `/command` through Captain.
No separate direct-execution command is introduced by this decision.

## Consequences

- A Boss turn has one orchestration meaning whether it enters through tmux or a shell pipeline.
- Headless CODE can call REVIEW through the real engagement stack instead of stopping at a synthetic suspended result.
- Cross-process continuation becomes a host-level Captain capability rather than a special case for one parked runtime.
- The nested runtime bridge, shared and bespoke linked runtimes, Captain shell, CLI, configuration, documentation, and release gates all require coordinated changes.
- The released direct-run surface changes incompatibly, so the implementation requires a new major version.
