<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-014: Durable one-shot run sessions

## Status

Superseded by [DR-031](031-shared-captain-session-front-ends.md).
[DR-032](032-explicit-roles-session-players.md) also replaces the legacy runtime snapshot's overloaded player question and token identities with schema `3` local-role projections and discriminated askers.

## Context

The non-interactive `playbook run` subcommand drives one Boss turn to a terminal outcome and exits.
When the playbook instead parks awaiting a Boss reply, the one-shot host prints a diagnostic and exits `3`, and every artifact of the run — the FSM state, the pending question, and each player's backend conversation token — dies with the process.
The Boss cannot see what was asked without scraping stderr progress lines, and cannot answer it at all.

Interactive `playbook` does not have this problem because the Playbook Captain shell keeps the parked runtime alive in memory ([DR-008](008-playbook-captain-shell.md) §2); its "resume" never crosses a process boundary.
[DR-010](010-playbook-session-tracing-and-resume.md) §6 and [DR-011](011-composable-playbook-execution.md) §6 both defer durable storage and cross-process runtime restoration to a separate decision.
This is that decision, scoped to the one-shot host.

The mechanics are already in reach.
A linked runtime is one XState v5 actor plus a small JSON-friendly closure (the player resume-token map of [DR-010](010-playbook-session-tracing-and-resume.md) §3 and the trace/turn/call counters).
At a parked quiescent state the actor has no invoked children and no in-flight port work, so `getPersistedSnapshot()` is complete and inert, and cligent's player resume tokens for every supported adapter name backend sessions that the agent CLIs persist on disk, so they stay valid in a later process.
A runtime suspended on a nested playbook call is the opposite: its invoked promise actor awaits a live deferred that cannot be persisted.

Established non-interactive agent CLIs set the conventions a one-shot resume surface should follow rather than reinvent [[1]] [[2]]:
Claude Code's print mode reports a `session_id` in its `--output-format json` envelope and accepts `--resume <session-id>` with a new prompt; Codex CLI resumes with `codex exec resume <SESSION_ID> "follow-up"` or `codex exec resume --last`, reads long prompts from stdin, and reserves stdout for the final agent message while progress streams to stderr.

## Decision

### 1. Parked-session snapshot capability

The shared runtime contract gains an optional, paired capability:

- `exportSnapshot(): PlaybookRuntimeSnapshot | undefined` — returns a JSON-safe snapshot of the live session, or `undefined` whenever the runtime is not at a safe capture point.
- `restore(session: PlaybookSession, snapshot: PlaybookRuntimeSnapshot): Promise<void>` — an alternative to `init` that rehydrates a previously exported snapshot under the same immutable session identity.

A safe capture point is between public boundaries: initialized, not disposing or disposed, no active turn, no pending nested playbook call, and the actor parked at a quiescent active state.
A runtime suspended on a nested call shall never export.

The snapshot carries a `schemaVersion`, the `playbookId`, the XState persisted machine snapshot as an opaque JSON-safe value (raw `Error` values such as FSM `lastError` normalized to `{ name, message, stack? }` on the way out), the player resume-token map, the trace/turn/judge-call/player-call/playbook-call sequence counters, the direct-Captain-call counter where the runtime supports direct Captain calls, the current normalized state descriptor, and the pending Boss questions as a host-readable list of `{ questionId, player, question, sourceItem? }`.
The `captainCall` sequence member is optional for schema-version-`1` compatibility: direct-Captain-capable runtimes shall persist it, while restore shall use the persisted global `trace` counter as a collision-safe floor when an older snapshot omits it.
The pending-question list is first-class in the snapshot precisely so a host can show the Boss what was asked without parsing status lines or subscribing to telemetry.

`restore` binds the same `PlaybookSession` identity the session was exported under, reconstructs the actor from the persisted machine snapshot, restores the resume-token map and sequence counters (using the persisted `trace` counter as the floor for an absent legacy `captainCall` counter), and emits no `session.started` trace — the session already started.
The next public boundary continues the session's contiguous trace sequence.
The host is responsible for recreating the runtime through the same factory with equivalent options and ports; the runtime validates the snapshot's schema version and `playbookId` and rejects a snapshot it cannot rehydrate.

Because both members are optional, a runtime that predates or declines the capability is simply not durable; hosts shall treat the absence of `restore` as "this playbook cannot resume" and fail with a diagnostic rather than silently starting fresh.

### 2. A session may park across processes

[DR-010](010-playbook-session-tracing-and-resume.md) §1 defined a playbook session as one `init`-through-`dispose` lifecycle.
This decision amends that definition: a playbook session is one logical lifecycle from its first `init` to its final settlement, and it may span multiple host processes through export/restore segments.
A host that has exported and persisted a parked snapshot may terminate its process without calling `dispose`; the parked session is suspended, not ended.
`session.disposed` marks true session end — terminal completion, failure disposal, or deliberate abandonment — never a parked hand-off.

### 3. One-shot session store

`playbook run` persists parked sessions as one JSON file per session at
`${XDG_STATE_HOME:-$HOME/.local/state}/playbook/sessions/<sessionId>.json`, created `0600` in directories created `0700`, because the snapshot embeds player resume tokens that [DR-010](010-playbook-session-tracing-and-resume.md) §2 classifies as sensitive.
The file carries everything a later invocation needs to rebuild the identical host: the resolved `<from>` specifier, the captain and per-role agent bindings, the playbook option slice, the agents' working directory, creation/update timestamps, and the runtime snapshot itself.

The store lives its lifecycle with the session: written when a one-shot turn parks awaiting a Boss reply, rewritten when a resumed turn parks again, and removed when a resumed turn reaches a terminal outcome.
A failed or aborted resumed turn leaves the file in place so the Boss may retry; the retry replays from the last parked state, accepting that the player backends have since advanced.

### 4. Resume surface

The resume surface follows the Codex/Claude conventions [[1]] [[2]]:

- `playbook run resume <session-id> [reply]` continues a persisted session with the Boss reply; `playbook run resume --last [reply]` picks the most recently updated persisted session.
- `[reply]` is read from stdin when omitted, the same long-text path the first run already gives `[task]`.
- On a parked outcome the pending question text is the run's product and prints to stdout; progress stays on stderr along with one hint naming the session id and the exact resume command.
- `--json` prints one envelope object to stdout carrying the outcome, the `sessionId`, and the outcome's payload (terminal `output` or the pending `questions`), so scripts learn the session id the same way they learn Claude Code's `session_id`.
- Agent bindings and options are read from the session store; binding flags on `resume` are rejected rather than silently ignored, because changing the lineup mid-session would break player continuity.

### 5. Preserved scope

- No resume for a runtime suspended on a nested playbook call; the one-shot host still cannot answer it, and its state cannot be safely persisted (§1).
- No trace persistence and no trace-replay reconstruction; the boundary trace remains observer-facing ([DR-010](010-playbook-session-tracing-and-resume.md) §6).
- No cross-process resume for the interactive Playbook Captain shell; its parked engagements remain in-memory ([DR-008](008-playbook-captain-shell.md)).
- The compiled default Captain exposes the shared factory's snapshot methods, but the interactive shell does not persist or restore Captain snapshots and Captain never runs one-shot.

## Consequences

- A non-interactive playbook that needs one Boss answer is no longer a dead end: the question reaches stdout, the session survives on disk, and one more `playbook run resume` invocation finishes the job.
- The runtime contract grows two optional members; existing hosts and runtimes remain valid, and capability absence fails loud at the CLI instead of silently forking a fresh session.
- The session store holds resume tokens on disk under user-only permissions; deleting a session file is always safe and merely abandons the parked session.
- Repeated resumes from the same parked file are permitted and behave like agent-CLI session forking: the snapshot state replays, while player backends continue from wherever they actually are.

## References

[1]: https://code.claude.com/docs/en/headless "Claude Code: run programmatically (print mode, --resume, session_id envelope)"
[2]: https://developers.openai.com/codex/noninteractive "Codex CLI: non-interactive mode (codex exec, resume, --last, stdin)"
