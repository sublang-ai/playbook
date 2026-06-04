<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-007: No raw judge JSON on the Captain pane

## Status

Accepted

## Context

The tmux-play adapter wires the runtime's `callJudge` port to
cligent's `context.callCaptain` per
[PBRT-15](../dev/playbook-runtime.md#pbrt-15) and
[DR-004 §11](./004-link-code-fsm-to-playbook-runtime.md#11-host-adapter-tmux-play).
cligent streams every `callCaptain` reply to the Boss pane.

The judge's replies are control-plane JSON, not Boss-facing prose:

- classification returns `{ event, payload }`;
- adjudication returns `{ guard, …payloadFields }`.

So the Boss pane shows that JSON verbatim *and* the runtime's own
human-readable glyph lines for the same transitions
([PBRT-3](../user/playbook-runtime.md#pbrt-3),
[PBRT-14](../dev/playbook-runtime.md#pbrt-14)) — duplicated, noisy,
and contradicting the "follow the FSM without reading the player
panes" intent.
PBRT-15 ("wire `callJudge` to `callCaptain`") thus conflicts with
PBRT-3/14 ("the pane is human-readable").

A second-order effect: a player's clarifying question was, before
this DR, partly legible only as a side effect of the adjudicator's
JSON (its `question` field) plus an 80-char `q="…"` rider on the
`awaitBossReply` marker.
Hiding the JSON removes that incidental view, so the runtime must
surface the question itself or the Boss loses it.

## Decision

### 1. Hidden judge calls

`@sublang/cligent` is adding
`callCaptain(prompt, { visibility: 'hidden' })`: it runs the call
and returns `finalText` but emits no pane records.
CODE's adapter shall route **every** judge call — classification
and adjudication alike — through the hidden form, per the amended
[PBRT-15](../dev/playbook-runtime.md#pbrt-15).
The runtime stays the sole composer of Boss-pane content; the
judge's JSON never reaches the pane.

This reconciles PBRT-15 with PBRT-3/14: the pane carries only the
runtime's composed lines.

### 2. Full question as captain speech

Because hiding the JSON removes the Boss's incidental view of a
player's question, on entry to `awaitBossReply` the runtime shall
emit two `emitStatus` lines, in order:

1. the **full** pending question as a captain-speech act
   attributed to the asking player — `<player> asks: <question>`,
   verbatim and untruncated, no glyph, rendered as captain speech;
2. the routing marker
   `◆ awaiting Boss reply · <resumeStateId> · <player> ·
   <sourceItem>`, with the former `q="<first 80 chars>"` rider
   **dropped**.

Telemetry is unchanged: `playbook.fsm.state` still carries
`pendingBossQuestion.question` verbatim for non-tmux-play hosts.

### 3. Transitional cligent dependency

The installed `@sublang/cligent` ("latest") does not yet type the
`visibility` option.
The dependency shall **not** be bumped and the lockfile shall
**not** be touched for this change.
The adapter compiles against today's published types via a
temporary local module augmentation of `@sublang/cligent/tmux-play`
that adds the hidden-visibility overload to `callCaptain`; it
carries a `TODO(cligent-bump)` marker and is deleted when the
option ships.

The end-to-end "judge JSON never reaches the Boss pane" integration
test ([PBRT-32](../test/playbook-runtime.md#pbrt-32)) is gated
behind a `CLIGENT_SUPPORTS_HIDDEN_CAPTAIN` flag that is `false`
today, so `pnpm test` skips it rather than failing it; the flag
flips to `true` with the bump.

### 4. Scope

- This DR covers CODE's half only.
  cligent's own implementation of hidden visibility is cligent's.
- The failure-state `emitStatus` data argument is unchanged: it
  still carries the compact `{ name, message }` form of `lastError`
  per [PBRT-14](../dev/playbook-runtime.md#pbrt-14).
- [DR-004 §11](./004-link-code-fsm-to-playbook-runtime.md#11-host-adapter-tmux-play)'s
  port-wiring table is amended: the `callJudge` row passes
  `{ visibility: 'hidden' }` into `context.callCaptain`.

## Consequences

- The Boss pane stays human-readable; the judge's JSON no longer
  duplicates the runtime's glyph lines.
- The Boss sees the full player question as captain speech; the
  `awaitBossReply` marker keeps only routing metadata.
- The only carries until the cligent bump are one self-removing
  module augmentation and one gated test; both are removed in the
  same change that bumps cligent.
- Hiding *all* judge calls means classification reasoning is also
  off the pane; the bare FSM event type (captain-speech
  classification line) remains the Boss's view of how a turn was
  classified, per PBRT-3.
