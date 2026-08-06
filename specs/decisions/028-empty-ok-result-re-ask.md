<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-028: Corrective re-ask on empty ok player and Captain results

## Status

Accepted.

## Context

A CODE run failed with `captainBridge: callPlayer returned status=ok with no finalText`.
The trigger was a claude-adapter bug, fixed in cligent.
But the shape itself is legal: any adapter may return `ok` with no text, because cligent keeps `finalText` optional [[1]].
Today the engine fails closed at once, so one transient empty result costs the whole turn.
The two call boundaries also disagreed on whether `''` counts as empty.

## Decision

- On an `ok` result whose `finalText` is missing, empty, or whitespace-only, the runtime re-issues the same call exactly once and reads the second result under the unchanged rules.
- This holds at both boundaries: `callPlayer` and `callCaptain`.
- Both boundaries use that same empty predicate, closing the `''` asymmetry.
- Non-`ok` results, thrown calls, and aborts are never retried ([DR-025](025-resilient-captain-control-adjudication.md)'s transport exclusion).
- A second empty result follows the existing failure path.
- A retry preserves the originating call's continuity policy: player retries follow player-session continuity ([PBRT-38](../dev/playbook-runtime.md#pbrt-38)); only the controller Captain's calls join [DR-029](029-session-scoped-conversational-captain.md)'s durable conversation; all other Captain and judge calls keep their existing isolation.
- When an empty controller result also loses continuity, the journal-seeded reseed is the single corrective call — never a reseed plus another retry.

Rejected: fail-open passthrough (hides faults), multi-retry (loops on deterministic bugs), and adapter-only fixes (the shape stays legal for every adapter).
The implementing IR carries the item amendments, trace details, and test pins.

## Consequences

- A transient empty result costs one extra call instead of the whole turn; failure-sink semantics and cligent's contract are unchanged.

## References

[1]: https://github.com/sublang-ai/cligent/blob/main/specs/user/tmux-play.md#tmux-033 "cligent TMUX-033 — PlayerRunResult shape"
