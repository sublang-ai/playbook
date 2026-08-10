<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-026: Shared Linked-Runtime Factory

## Goal

Implement [DR-019](../decisions/019-shared-linked-runtime-factory.md): move the generic FSM-interpreter machinery out of each linked artifact into the shared `createXStatePlaybookRuntime(machine, spec)` factory, port the reference CODE artifact to the thin form under its unchanged suites, and make `slc/link.md` emit thin modules.

## Deliverables

- [x] DR-019 plus amended [PBRT-5](../dev/playbook-runtime.md#pbrt-5), [RELEASE-15](../dev/release.md#release-15), and [RELEASE-18](../test/release.md#release-18).
- [x] `src/xstate-playbook-runtime.ts` with committed `.js`/`.d.ts` siblings, re-exported from `@sublang/playbook/xstate-runtime`, shipped in `files`, guarded by the CI drift checks, and unit-tested over synthetic player/script/captain/nested FSMs.
- [x] Thin `reference/sdlc/code.playbook/code.playbook.ts` passing its behavior, prompt-contract, and declaration-contract suites unchanged.
- [x] Rewritten `slc/link.md` §Output thin-module contract (with §Script execution and §Nested playbook bridge pointing at the shared factory).
- [x] Version 1.3.0 and the `[Unreleased]` CHANGELOG entry.

## Tasks

1. **Author DR-019 and the spec surface.** _[done]_ DR-019, this iteration, amended PBRT-5, RELEASE-15, and RELEASE-18, and the map rows precede code changes.
2. **Add the shared factory and thin the CODE artifact.** _[done]_ Hoist the CODE machinery into `src/xstate-playbook-runtime.ts` behind the DR-019 `spec` surface with generic defaults, add the factory unit tests, re-export from `src/xstate-runtime.ts`, extend `package.json` `files`, the package-surface pins, and the CI drift lists, and reduce `code.playbook.ts` to its CODE-specific spec plus the factory call.
   DISCUSS keeps its parallel-region machinery and the default Captain keeps its hand-authored runtime, both per DR-019 §4 — their suites pin observably different machinery, so a port would change behavior their tests forbid.
3. **Rewrite the `slc/link.md` output contract.** _[done]_ §Output specifies the thin emitted module (FSM import, derived options interface plus `cwd` for script states, shared-contract re-exports, `_internal` composers, default-exported factory call, bare package specifiers for the shared modules).
4. **Bump to 1.3.0 and record the change.** _[done]_ `package.json` version and the Keep-a-Changelog `[Unreleased]` entry.

## Acceptance criteria

- The shared factory provides every actor kind a linked FSM declares — player, script, captain, nested playbook (literal and dynamic) — with the DR-019 generic defaults, verified by `src/xstate-playbook-runtime.test.ts`, including canonical placeholder mapping, exact flat Boss-event classification with parked fresh directives and non-weakening metadata merges, direct-Captain first-error propagation and tool-policy trace fidelity, abort-before-transition behavior, and unique Captain call ids across current and legacy snapshot restore.
- `code.playbook.ts` delegates to the shared factory; `code.playbook.test.ts`, `code.prompt-contract.test.ts`, and `code.playbook.contract.test.ts` pass without any expectation change.
- Every pre-existing export of `@sublang/playbook/runtime` and `@sublang/playbook/xstate-runtime` still resolves (package-surface suite), so fat artifacts keep running.
- `npm pack` ships the new factory siblings and `pnpm build` leaves every committed `.js`/`.d.ts` shipping artifact unchanged.
- DISCUSS and Captain runtime sources are byte-identical to their pre-iteration state.
- `pnpm test` and `pnpm build` pass.
