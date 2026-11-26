<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-010: Playbook session tracing and player resume

## Status

Accepted.
Amends [DR-005](005-boss-reply-suspension-path.md).
Amended by [DR-011](011-composable-playbook-execution.md), [DR-031](031-shared-captain-session-front-ends.md), [DR-032](032-explicit-roles-session-players.md), [DR-040](040-outcome-authority-effect-reconciliation.md), [DR-042](042-shared-session-store-and-replay-stream.md).

## Context

A linked `PlaybookRuntime` currently receives only ports at `init`, so neither the runtime nor its telemetry has a stable playbook-session identity.
Its player result contract also discards cligent's authoritative `resumeToken`.

tmux-play owns one persistent `Cligent` per host player and auto-resumes that player's latest token when a Captain omits resume control.
The Playbook Captain shell creates a replacement runtime after final completion or dismissal, but the replacement currently reaches the same host player without forcing a fresh backend conversation.
This can leak an earlier engagement's player context into a new playbook session.

cligent distinguishes its transport `AgentEvent.sessionId` from the opaque backend `resumeToken` used for continuation.
Only the latter is safe for resume [[1]].

## Decision

### 1. Session identity

A playbook session is one logical lifecycle from its first `PlaybookRuntime.init` to its final settlement, and it may span host processes under [DR-031](031-shared-captain-session-front-ends.md) §8.

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
| `schemaVersion` | The current trace schema version. |
| `sessionId` | The immutable playbook-session UUID. |
| `playbookId` | The stable playbook id supplied at init. |
| `sequence` | Contiguous one-based integer within the session. |
| `timestamp` | Unix epoch milliseconds. |
| `type` | One of the trace types below. |
| `turnId` | Runtime-local, one-based Boss-input id where applicable. |
| `callId` | Stable id shared by matching call-started and call-finished events. |
| `payload` | JSON-safe event data. |

The base trace types and payloads below are extended by [DR-011](011-composable-playbook-execution.md) §5 with structured state, suspended settlement, causal session fields, and nested-call pairs, by [DR-032](032-explicit-roles-session-players.md) with distinct local role and resolved player identities, and by [DR-040](040-outcome-authority-effect-reconciliation.md) with governed transition evidence.

The base trace types shall be `session.started`, `boss.input.received`, `judge.call.started`, `judge.call.finished`, `player.call.started`, `player.call.finished`, `fsm.transition`, `status.emitted`, `boss.input.settled`, and `session.disposed`.

Their payloads shall use the following common vocabulary; fields marked optional are omitted when unavailable rather than synthesized:

| Trace type | Payload |
| --- | --- |
| `session.started` / `session.disposed` | `{ stateId?: string }` for the initial or last known runtime state. |
| `boss.input.received` | `{ text: string }`, preserving the exact input. |
| `boss.input.settled` | `{ outcome, stateId?, error? }`, where `outcome` is `quiescent`, `no-action`, `failed`, `terminal`, or `aborted`. |
| `judge.call.started` | `{ purpose, stateId?, prompt }`. |
| `judge.call.finished` | `{ purpose, stateId?, status, reply?, error? }`. |
| `player.call.started` | `{ purpose, stateId?, sourceItem, roleId, playerId?, prompt, resume }`. |
| `player.call.finished` | `{ purpose, stateId?, sourceItem, roleId, playerId?, resume, status, resumeToken?, finalText?, error? }`. |
| `fsm.transition` | The runtime's existing JSON-safe transition payload, including its `from`, `to`, event, pending-question, and error data where applicable. |
| `status.emitted` | `{ message, data?, stateId? }`, preserving the exact host status arguments; `stateId` is optional context. |

Every `status` is `ok`, `aborted`, or `error`. Every `error` is normalized to the JSON-safe shape `{ name: string, message: string, stack?: string }`; a string error becomes `{ name: "Error", message: <the string> }`.
Judge `purpose` uses the shared values `boss-input-classification` and `player-output-adjudication` so trace consumers do not need playbook-specific labels.
Player and judge pairs shall therefore contain their exact prompts and final replies, normalized errors, purposes and state ids where known, resolved player ids, explicit resume selection, result status, and returned resume token.

Trace emissions shall be awaited, never dropped, and sequenced before the boundary operation or human status/state telemetry they describe.
Trace data shall not be copied into Boss-visible status, summaries, or hidden-router prompts.
Resume tokens are opaque credentials for backend conversations; observers that persist `playbook.trace` shall protect them as sensitive data.

### 3. Player-session continuation

The shared contract shall add `PlayerCallOptions { resume: string | false }`, require it on every `PlaybookPorts.callPlayer` call, and add optional `resumeToken` to `PlayerResult`.

Each runtime shall use a bounded continuation store from resolved local player id to the latest non-empty resume token.
The store is runtime-owned unless a composing host supplies the frame's view of its logical Captain session's continuation ledger ([DR-032](032-explicit-roles-session-players.md)).
For the first call to a fresh binding, the runtime shall pass `resume: false`; omission is not permitted because a host may otherwise auto-resume an older conversation.
For a later call, the runtime shall pass the exact stored token.

After every resolved player call, the runtime shall replace the stored token when the result carries a non-empty `resumeToken`, clear it when an `ok` result omits one, and preserve it when an `aborted` or `error` result omits one, before interpreting the result status ([DR-032](032-explicit-roles-session-players.md)).
A thrown port call with no result shall leave the prior token unchanged.
The runtime shall not retry fresh after an invalid resume token.

Runtime-owned continuation survives parked Boss turns and an actor rebuild inside that runtime, and is discarded on runtime disposal.
Host-owned continuation is the logical Captain session's ledger keyed by explicitly bound player id: it survives child return, root completion, and process hand-off, and is shared only by frames bound to the same player id.

### 4. tmux-play bridge

cligent's Captain contract shall accept an optional `CallPlayerOptions.resume` value and forward it to `Cligent.run`.
Omission preserves cligent's legacy player-level auto-resume for other Captains; the Playbook Captain path shall always forward the runtime's explicit string or `false` selection.

The shell shall return the host's `PlayerRunResult.resumeToken` through `PlaybookPorts` without rewriting it.
It shall never use a nested `AgentEvent.sessionId` for continuation.

The shell shall use cligent's live-session `Captain.prepareDispose()` hook to dispose an active linked runtime before tmux-play aborts `CaptainSession.signal` and closes emissions. Its ordinary `Captain.dispose()` remains an idempotent fallback. This ordering makes the terminal `session.disposed` trace observable during active host teardown without weakening cligent's post-close disposal semantics.

### 5. Boss-question continuation

[DR-005](005-boss-reply-suspension-path.md) §5 is amended: the labelled Boss question and answer blocks remain mandatory, and the resumed state may additionally continue the same backend player session under this decision.
The explicit Q+A remains deterministic input and an adapter-independent fallback; backend resume preserves conversation and tool context.

### 6. Preserved scope

This decision exposes no resume token in the Boss UI and adds no Boss-selected root engagement beyond one.
Durable sessions and cross-process restoration belong to [DR-031](031-shared-captain-session-front-ends.md), and durable storage to [DR-042](042-shared-session-store-and-replay-stream.md), which persists a token-free projection rather than the trace itself; a host observer may still persist `playbook.trace`.

## Consequences

- A playbook engagement has one immutable correlation id across Boss turns, runtime telemetry, player calls, and disposal.
- A new logical Captain session starts every player fresh instead of inheriting tmux-play's prior host-player conversation.
- Parked and nested mapped engagements resume each resolved player explicitly from the last authoritative adapter token.
- The public runtime contract and authored linker contract change incompatibly before 1.0.
- Trace sinks can reconstruct the complete runtime-boundary history without an unbounded conversation ledger in the Captain shell.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/packages/tmux-play.md#tmux-033 "cligent player-result continuation contract"
