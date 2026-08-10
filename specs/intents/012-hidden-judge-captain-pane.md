<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-012: No raw judge JSON on the Captain pane — CODE half

## Status

Done

## Intent

Implement CODE's half of [DR-007](../decisions/007-hidden-judge-captain-pane.md): keep the judge's control-plane JSON off the Boss pane so it no longer duplicates the runtime's composed glyph lines, and surface a suspended player's full question as captain speech.

The runtime already composes human-readable lines ([[playbook-runtime-3](../packages/playbook-runtime.md#playbook-runtime-3)] / [[playbook-runtime-14](../packages/playbook-runtime.md#playbook-runtime-14)]); routing `callJudge` through cligent's `callCaptain` ([[playbook-runtime-15](../packages/playbook-runtime.md#playbook-runtime-15)]) streamed the judge's JSON to the same pane, contradicting that. DR-007 reconciles the two: every judge call runs hidden, and the `awaitBossReply` entry shows the full question plus a rider-less marker.

## Single-commit rationale

This lands as **one commit**: the spec reconciliation (DR-007 + PBRT amendments), the adapter's hidden call, the runtime's two-line `awaitBossReply` entry, and the tests are mutually dependent halves of one behavioral change. The pending end-to-end test is gated off (`CLIGENT_SUPPORTS_HIDDEN_CAPTAIN = false`), so `pnpm test` stays green without the cligent bump, and the temporary module augmentation keeps `pnpm build` clean against today's published types. Splitting would leave intermediate states where spec and code disagree.

## Decisions baked in

- Every judge call — classification and adjudication — passes `{ visibility: 'hidden' }` to `context.callCaptain`; the runtime stays the sole composer of Boss-pane content (DR-007 §1).
- `awaitBossReply` entry emits two lines: the full question as captain speech `<player> asks: <question>` (verbatim, untruncated) then `◆ awaiting Boss reply · <resumeStateId> · <player> · <sourceItem>` with the `q=` rider dropped; telemetry keeps the full question (DR-007 §2).
- The installed `@sublang/cligent` ("latest") is not bumped and the lockfile is untouched; a temporary local module augmentation of `@sublang/cligent/tmux-play` adds the hidden-visibility overload so the adapter compiles, marked `TODO(cligent-bump)` (DR-007 §3).
- The failure-state `emitStatus` data argument is unchanged (compact `{ name, message }`); `lastError` shaping is out of scope (DR-007 §4).

## Deliverables

- [x] IR-012 doc, DR-007 doc, and their `map.md` rows landed.
- [x] [`specs/packages/playbook-runtime.md`](../packages/playbook-runtime.md) — playbook-runtime-3: two captain-speech acts; `awaitBossReply` emits the full-question speech line then the rider-less `◆` marker; judge JSON is not surfaced.
- [x] [`specs/packages/playbook-runtime.md`](../packages/playbook-runtime.md) — playbook-runtime-14 (two `emitStatus` lines, full-question telemetry retained) and playbook-runtime-15 (judge calls run hidden).
- [x] [`specs/packages/playbook-runtime.md`](../packages/playbook-runtime.md) — playbook-runtime-20 (two-line assertion), playbook-runtime-21 (every `callCaptain` passes `{ visibility: 'hidden' }`), and new playbook-runtime-32 (gated end-to-end no-JSON-on-pane test).
- [x] `code.tmux-play.ts` — `callJudge` passes `{ visibility: 'hidden' }`; temporary `@sublang/cligent/tmux-play` augmentation added with a `TODO(cligent-bump)` marker; siblings recompiled.
- [x] [`code.playbook.ts`](../../reference/sdlc/code.playbook/code.playbook.ts) — `awaitBossReply` entry emits the full-question captain-speech line then the rider-less marker; siblings recompiled.
- [x] `code.tmux-play.test.ts` — asserts every `callCaptain` passes `{ visibility: 'hidden' }`; adds the gated `describe.skipIf(!CLIGENT_SUPPORTS_HIDDEN_CAPTAIN)` integration test.
- [x] [`code.playbook.test.ts`](../../reference/sdlc/code.playbook/code.playbook.test.ts) — asserts the two `awaitBossReply` lines (full-question chat + rider-less marker) and that telemetry still carries the full question.

## Tasks

1. **Land the change as one commit.**
   Spec reconciliation (DR-007; playbook-runtime-3/14/15/20/21; new playbook-runtime-32; `map.md` rows for DR-007 + IR-012), adapter hidden call + temporary augmentation, runtime two-line `awaitBossReply` entry, and the two test updates, with `.js`/`.d.ts` siblings regenerated.
   `pnpm build` clean and `pnpm test` green (playbook-runtime-32 skipped, not failing).

## Verification

- The adapter's `callJudge` port invokes `context.callCaptain(prompt, { visibility: 'hidden' })`; every judge call (classification and adjudication) is hidden.
- The package compiles (`pnpm build`) against the installed `@sublang/cligent` with no dependency bump and no lockfile change, via the temporary module augmentation only.
- On entry to `awaitBossReply` the runtime emits `<player> asks: <full question>` then `◆ awaiting Boss reply · <resumeStateId> · <player> · <sourceItem>` (no `q=` rider); `playbook.fsm.state` telemetry still carries `pendingBossQuestion.question` verbatim.
- `code.tmux-play.test.ts` fails if any `callCaptain` call omits `{ visibility: 'hidden' }`; playbook-runtime-32's integration test is registered but skipped while `CLIGENT_SUPPORTS_HIDDEN_CAPTAIN` is `false`.
- `pnpm test` from the repo root is green with the gated test skipped, not failing.
