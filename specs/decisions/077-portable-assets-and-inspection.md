<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-077: Portable Assets and Inspection

## Status

Accepted (2026-10-01).
Amends [DR-049](049-portable-session-contract.md) with session-owned immutable assets and [DR-029](029-session-scoped-conversational-captain.md) with attachment context and visible worker evidence.

## Context

A path on the submitting machine is not a portable attachment.
Inline binary data makes replay streams large, and a Captain viewing an image does not make that image available to its acting workers.
Browser inspection requires an acting workflow while the Captain's routing and reporting remain tool-free.

## Decision

Playbook owns an immutable content-addressed asset store scoped to one owner, reusable for session, intent and draft owners without a shared mutable garbage collector.
Accepted session inputs and observed output evidence reference bytes copied into the session's own asset directory.
Session bundles, deletion and relocation include that directory; absolute materialization paths never become durable attachment references.
Replay retains its opaque version-1 envelope, while known host records externalize binary media before append.
A separate visible evidence record preserves the producing actor, call and turn without exposing hidden controller traffic.
Captain reporting may summarize attributed, bounded excerpts of visible player prose only after the host matches an accepted outcome to its acknowledged repository receipt and producing invocation.
These quotes establish what a player reported, never repository effects, authorization or completion; those remain authoritative settlement facts.
A host-owned reference saved atomically with the accepted player-step result binds that exact producing boundary and player, including when adopted frames have been disposed.
Recovery reconstructs quotes only through that reference; older unreferenced or ambiguous results contribute no report.
The reference copies no report text and changes no compiler or runtime port contract.

Text and attachment references are independent input fields.
Empty text with attachments is an accepted turn that asks for the task without inventing Boss text or invoking a text-only working runtime.
Engagements retain selected attachment references, nested calls inherit a snapshot, and unrelated root work starts with only its selected references.
Pending references require explicit validated selection across clarification turns; omission selects only the newly submitted references.
New Boss input added to active work belongs only to the addressed leaf; native generated evidence is also available to its still-active ancestors in the same root engagement, so a parent can reason about figures its child observed.
The evidence keeps its original producing actor and call, and neither kind of reference flows implicitly into an unrelated root.

Browser is a mutable execution capability captured at accepted-turn boundaries and excluded from structural identity.
Every control or Judge call explicitly disables browser and configured MCP servers.
A controller lacking native media support receives metadata and never prevents a capable worker from receiving required bytes.
An acting worker unable to consume required evidence fails its call explicitly.

A source-authored inspection builtin performs analysis and browser observation with an unchanged repository outcome.
It uses the existing compiler and runtime contracts without a new primitive.
Browser scratch files belong outside the governed repository.

The maintained Captain keeps its released state topology, event bridge and persisted snapshots.
Its authored attachment prompt and optional result fields are compiled through SLC, then reconciled into those compatible maintained artifacts with the complete fresh generated bundle and hashes retained as evidence.
This reconciliation is not represented as verbatim fresh compiler output; source preservation, generated conformance and a released-snapshot restore remain mandatory.
Inspect adopts its complete generated workflow without a new compiler primitive.

## Consequences

- Ownership-local copying makes deletion and synchronization deterministic at the cost of duplicate bytes across owners.
- Readers resolve stable asset references through the shared facade; they never guess paths from Markdown.
- Session hosts sharing new media-bearing state must understand the asset contract before executing it; stop older CLI and SDK writers before any upgraded host saves asset-bearing state.
- Browser changes affect the next accepted invocation without discarding conversation continuity or weakening fixed permission restrictions.
