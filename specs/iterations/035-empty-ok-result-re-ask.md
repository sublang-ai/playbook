<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-035: Empty ok-result re-ask

## Goal

Implement [DR-028](../decisions/028-empty-ok-result-re-ask.md): an `ok` player or direct-Captain result whose `finalText` is missing, empty, or whitespace-only earns exactly one corrective re-ask — the same call repeated through the same boundary under the originating call's continuity policy — before a second such result follows the existing failure path, with both boundaries unified on one empty predicate.

## Deliverables

- [x] DR-028, the amended [PBRT-9](../dev/playbook-runtime.md#pbrt-9)/[PBRT-47](../dev/playbook-runtime.md#pbrt-47) and [PBRT-23](../test/playbook-runtime.md#pbrt-23), the new [PBRT-51](../test/playbook-runtime.md#pbrt-51), the `slc/link.md` player/Captain result and trace contract updates, this record, the map rows, and the `[Unreleased]` CHANGELOG entry per [RELEASE-4](../dev/release.md#release-4).
- [x] The unified empty predicate and single corrective re-ask in the shared engine's delegated-player bridge and direct-Captain boundary/actor (`src/xstate-playbook-runtime.ts`), each call traced as its own started/finished pair, with [PBRT-38](../dev/playbook-runtime.md#pbrt-38) resume selection on the corrective player call and compiled siblings rebuilt.
- [x] The same predicate and re-ask at the linked DISCUSS reference runtime's player boundary (`reference/sdlc/discuss.playbook/discuss.playbook.ts`), with its compiled siblings rebuilt. The compiled default Captain keeps its single-throw until [IR-036](036-session-scoped-conversational-captain.md)'s [DR-029](../decisions/029-session-scoped-conversational-captain.md) rewrite, which carries DR-028's predicate and re-ask (its §7 prose validation).
- [x] Integration tests per PBRT-51 at both boundaries, with the PBRT-23 single-throw pins updated to the amended items.

## Tasks

1. **Spec surface.** _[done]_ Author DR-028, finalize the PBRT item amendments and the `slc/link.md` contract wording, and add this record and the map rows.
2. **Engine re-ask and tests.** _[done]_ Add the shared empty predicate and the single re-ask to `createPlayerBridge`, the direct-Captain call boundary, and the captain actor; update the old single-throw pins; add the PBRT-51 suites; rebuild compiled siblings.
3. **Linked-artifact parity.** _[done]_ Mirror the predicate and re-ask in the DISCUSS reference runtime's player boundary with its tests, and record the compiled default Captain's deferral to IR-036.

## Acceptance criteria

- At each boundary, a scripted empty-`ok` first result followed by a non-empty second result recovers the turn after exactly two host calls, each traced as its own started/finished pair; two empty results resolve the structured `failed` outcome after exactly two host calls; `''` and whitespace-only `finalText` behave exactly like a missing one; an `aborted` or `error` first result triggers no second host call.
- The corrective player call passes the resume selection the first result left per PBRT-38; a rejecting finish-trace emission triggers no re-ask; an abort that lands between the empty first result and the corrective call ends the turn as abort settlement with no second host call.
- The DISCUSS reference runtime recovers and fails the same shapes at its player boundary under the same predicate.
- `npm test` passes with the compiled `.js` / `.d.ts` siblings showing no drift after `npm run build`.
