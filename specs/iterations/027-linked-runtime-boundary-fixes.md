<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-027: Linked-Runtime Boundary and Boss-Event Fixes

## Goal

Correct four defects found reviewing the [DR-019](../decisions/019-shared-linked-runtime-factory.md) shared factory after 1.3.0's hardening commits, and retire one unsatisfiable test item.
The defects are conformance regressions against items and contract text that already exist, not new design.

## Deliverables

- [x] New [PBRT-47](../dev/playbook-runtime.md#pbrt-47): a host-reported direct-Captain result failure routes through the FSM error path to `failed` instead of rejecting the public boundary.
- [x] Derived `BOSS_INTERRUPT` contract carrying the runtime-owned `bossIntent` text field, and a merging (not replacing) derived-contract write.
- [x] `slc/link.md` naming the runtime-owned event types `bossEvents` shall never carry.
- [x] `bossEvents` validated at factory construction even when `classifyBossText` is overridden.
- [x] [PBRT-46](../test/playbook-runtime.md#pbrt-46) re-scoped to what its own integration suite can drive.
- [x] `[Unreleased]` CHANGELOG entries, including the missing `PlaybookRuntimeSnapshot.sequences.captainCall` note required by [RELEASE-4](../dev/release.md#release-4).

## Tasks

1. **Spec surface.** _[done]_ Add PBRT-47, drop the unit-only clause from PBRT-46, state the runtime-owned `bossEvents` exclusion in `slc/link.md`, and add this record and its map row.
2. **Runtime fixes and tests.** _[done]_ The four code fixes in `src/xstate-playbook-runtime.ts` with committed `.js`/`.d.ts` siblings, the corrected and added factory unit tests, and the CHANGELOG entries.

## Decisions baked in

- No item changed for the `bossIntent` derivation.
  `slc/link.md` §Boss-event mapping already binds the runtime to attach the exact original text as `bossIntent` for `BOSS_INTENT` and `BOSS_INTERRUPT`; the derivation simply did not, and an FSM reading `event.bossIntent` silently received `undefined`.
- No item changed for the `bossEvents` construction-time validation.
  [DR-019 §2](../decisions/019-shared-linked-runtime-factory.md#2-the-spec-parameter-surface) already requires conflicting duplicates to fail factory construction; a supplied classifier had short-circuited the only enforcement of it.
- DR-019 is unamended.
  No decision changed: the runtime-owned exclusion was implemented in 1.3.0 but recorded only in a shipped type's doc comment.
  The fix states it in `slc/link.md`, which is the contract text consumers vendor and pin.
- PBRT-47 is new because the existing items covered only the delegated-player boundary ([PBRT-9](../dev/playbook-runtime.md#pbrt-9)) and the aborted direct-Captain call ([PBRT-13](../dev/playbook-runtime.md#pbrt-13)), leaving the non-abort direct-Captain result failure unspecified — which is how the two boundaries came to disagree.
- PBRT-46's `captainCall` clause is removed rather than re-scoped.
  Its stated scope is the integration suite over real linked runtimes, and no shipped runtime both implements `exportSnapshot` and invokes a `captain` actor: CODE and DISCUSS have no direct-Captain invoke, and [PBRT-45](../dev/playbook-runtime.md#pbrt-45) forbids the compiled Captain the durable capability.
  Only the synthetic factory unit tests can drive it, and [META-21](../meta.md#meta-21) forbids unit tests as spec items.
  The behavior stays specified by PBRT-45, which already carries it, and stays covered by the factory unit tests.
- The factory's own tests stay unspecified for the same reason: `src/xstate-playbook-runtime.test.ts` is the DR-019 unit suite, so PBRT-47 gains no test item.

## Acceptance criteria

- A `callCaptain` result with status `error` or `aborted`, or `ok` with no `finalText`, resolves `handleBossInput` with outcome `failed`, the FSM at its failure state, and the host error as the state's recorded error — identical to the delegated-player boundary for the same class of failure.
- A thrown `callCaptain` port, a malformed host result, and a rejecting `captain.call.finished` sink still reject the public boundary, and a rejecting finish sink still leaves the host-result failure as the failure state's evidence.
- An FSM whose root `BOSS_INTERRUPT` reads `event.bossIntent` receives the exact Boss text without the linker supplying `bossEvents`.
- Construction rejects a `bossEvents` contract that conflicts with a runtime-derived one even when the spec supplies `classifyBossText`.
- `pnpm test`, `pnpm build` with zero sibling drift, and `npx tsc --noEmit` pass.
