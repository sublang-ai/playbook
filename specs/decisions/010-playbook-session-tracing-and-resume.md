<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-010: Playbook session tracing and player resume

## Status

Accepted.

## Context

A linked `PlaybookRuntime` currently receives only ports at `init`, so neither the runtime nor its telemetry has a stable playbook-session identity.
Its player result contract also discards cligent's authoritative `resumeToken`.

tmux-play owns one persistent `Cligent` per host player and auto-resumes that player's latest token when a Captain omits resume control.
The Playbook Captain shell creates a replacement runtime after final completion or dismissal, but the replacement currently reaches the same host player without forcing a fresh backend conversation.
This can leak an earlier engagement's player context into a new playbook session.

cligent distinguishes its transport `AgentEvent.sessionId` from the opaque backend `resumeToken` used for continuation.
Only the latter is safe for resume.

## Decision

### 1. Session identity

A playbook session is one `PlaybookRuntime.init` through `dispose` lifecycle.

The shared runtime contract shall expose `PlaybookSession`, carrying a non-empty `sessionId`, the stable `playbookId`, and the runtime's `PlaybookPorts`.
`PlaybookRuntime.init` shall accept that object.

The Playbook Captain shell shall generate a previously unissued UUID for every new engagement and shall retain it while that same runtime is parked and resumed.
A replacement engagement after final completion or dismissal shall receive a new UUID.

The playbook `sessionId` and a player `resumeToken` are different identifiers and shall not be substituted for one another.

### 2. Boundary-complete trace

Every linked runtime shall emit an ordered trace through `emitTelemetry` topic `playbook.trace`.
"Full trace" means every input, output, transition, and failure observable at the `PlaybookRuntime` boundary; adapter-internal streaming events remain the host record stream's responsibility.

Every trace payload shall carry:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Literal `1`. |
| `sessionId` | The immutable playbook-session UUID. |
| `playbookId` | The stable playbook id supplied at init. |
| `sequence` | Contiguous one-based integer within the session. |
| `timestamp` | Unix epoch milliseconds. |
| `type` | One of the trace types below. |
| `turnId` | Runtime-local, one-based Boss-input id where applicable. |
| `callId` | Stable id shared by matching call-started and call-finished events. |
| `payload` | JSON-safe event data. |

The trace types shall be `session.started`, `boss.input.received`, `judge.call.started`, `judge.call.finished`, `player.call.started`, `player.call.finished`, `fsm.transition`, `status.emitted`, `boss.input.settled`, and `session.disposed`.

Player and judge trace pairs shall contain their exact prompts and final replies, normalized errors, purposes and state ids where known, resolved player ids, explicit resume selection, result status, and returned resume token.
FSM trace events shall preserve the runtime's existing transition, pending-question, and normalized-error data.
Boss-input trace pairs shall include the exact input and its quiescent, no-action, failed, terminal, or aborted outcome.

Trace emissions shall be awaited, never dropped, and sequenced before the boundary operation or human status/state telemetry they describe.
Trace data shall not be copied into Boss-visible status, summaries, or hidden-router prompts.

### 3. Player-session continuation

The shared contract shall add `PlayerCallOptions { resume: string | false }`, require it on every `PlaybookPorts.callPlayer` call, and add optional `resumeToken` to `PlayerResult`.

Each runtime shall keep a bounded map from resolved local player id to the latest non-empty resume token.
For the first call to a player in a playbook session, the runtime shall pass `resume: false`; omission is not permitted because a host may otherwise auto-resume an older conversation.
For a later call, the runtime shall pass the exact stored token.

After every resolved player call, the runtime shall replace the stored token when the result carries a non-empty `resumeToken`, or clear it when the result omits one, before interpreting the result status.
An aborted or error result may therefore preserve a returned token.
A thrown port call with no result shall leave the prior token unchanged.
The runtime shall not retry fresh after an invalid resume token.

The map key shall be the resolved player id, so a composite role such as Committer shares the Coder or Reviewer session it actually invokes.
The map survives parked Boss turns and an actor rebuild inside the same runtime, and is discarded on runtime disposal.

### 4. tmux-play bridge

cligent's Captain contract shall accept an optional `CallPlayerOptions.resume` value and forward it to `Cligent.run`.
Omission preserves cligent's legacy player-level auto-resume for other Captains; the Playbook Captain path shall always forward the runtime's explicit string or `false` selection.

The shell shall return the host's `PlayerRunResult.resumeToken` through `PlaybookPorts` without rewriting it.
It shall never use a nested `AgentEvent.sessionId` for continuation.

### 5. Boss-question continuation

[DR-005 §7](005-boss-reply-suspension-path.md#7-transcript-embedding-with-player-session-resume) is amended: the labelled Boss question and answer blocks remain mandatory, and the resumed state may additionally continue the same backend player session under this decision.
The explicit Q+A remains deterministic input and an adapter-independent fallback; backend resume preserves conversation and tool context.

### 6. Preserved scope

This decision does not add persisted XState checkpoints, rehydrate a disposed runtime, expose resume tokens in the Boss UI, add multiple active engagements, or persist the trace itself.
A host observer may persist `playbook.trace`; durable storage and cross-process runtime restoration require a separate decision.

## Consequences

- A playbook engagement has one immutable correlation id across Boss turns, runtime telemetry, player calls, and disposal.
- New engagements start every player fresh instead of inheriting tmux-play's prior host-player conversation.
- Parked engagements resume each resolved player explicitly from the last authoritative adapter token.
- The public runtime contract and authored linker contract change incompatibly before 1.0.
- Trace sinks can reconstruct the complete runtime-boundary history without an unbounded conversation ledger in the Captain shell.
