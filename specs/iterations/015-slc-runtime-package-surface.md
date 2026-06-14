<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-015: SLC-facing runtime contract and slc specs as package surface

## Goal

Expose the SLC-facing public surface of `@sublang/playbook` in reviewable slices.

The end state is:

- An authored, type-only `src/runtime.ts` published as
  `@sublang/playbook/runtime`, the single source for the runtime
  contracts `PlayerResult`, `PlaybookPorts`, `PlaybookRuntime`, and
  `PlaybookRuntimeFactory<Options = unknown>`.
- The committed CODE artifacts re-export / import those shared types
  instead of redefining them locally, pinned by a type-identity test.
- `slc/**` shipped in the published package and resolvable through a
  `./slc/*` export, so downstream consumers can read the authored
  compiler-phase specs.
- `/runtime` and `slc/*` documented as public, semver-stable surfaces.

This extends [slc/link.md §Output](../../slc/link.md#output) and
[DR-004 §10](../decisions/004-link-code-fsm-to-playbook-runtime.md) — the
runtime contract types become a shared authored module the emitted CODE
module imports, rather than types each artifact redefines.
`slc/link.md` stays the authored spec contract; `src/runtime.ts` is the
TypeScript projection of it.

### Out of scope

- No linker or runtime-engine export and no engine TODO; the runtime
  engine stays emitted per artifact (`code.playbook.ts`).
- No new host adapter, host config, or presentation surface.
- No change to FSM behavior, prompts, guard keys, or result semantics.

## Deliverables

- [x] IR-015 doc and its `map.md` row.
- [x] Spec amendments: `slc/link.md` §Output and DR-004 §10 record the
      shared `@sublang/playbook/runtime` source and the
      `PlaybookRuntimeFactory<Options = unknown>` contract; PBRT-5
      relaxed so the runtime module may also import the shared runtime
      type contract; RELEASE items add `/runtime` and `slc/*` as public
      semver-stable surfaces shipped via `files`/`exports` plus the
      `import.meta.resolve` + fs consumer pattern; new PBRT consistency
      and CODE type-identity dev/test items; new RELEASE test items for
      slc resolution and `npm pack` inclusion.
- [x] `src/runtime.ts` authored as the type-only contract source, with
      committed compiled `.js` (minimal, valid) and `.d.ts`, the `tsc`
      build extended to emit them, and the CI drift check extended to
      cover them.
- [x] `package.json` adds `exports['./runtime']` (`types` + `default`)
      and the `/runtime` artifacts to `files`.
- [ ] Committed CODE artifacts (`code.playbook.ts` / `.js` / `.d.ts`)
      import and re-export the shared runtime types instead of local
      redefinitions, with the generation header/contract updated and
      test resolution wired for the self-referencing specifier.
- [ ] `package.json` adds `slc/**` to `files` and
      `exports['./slc/*'] = './slc/*'`; README documents
      `@sublang/playbook/runtime` and reading `slc/*.md` via
      `import.meta.resolve` + fs.
- [ ] Tests: downstream type import; `/runtime` imports no CODE/FSM
      types transitively; consistency check of `PlayerResult.status`
      and the four `PlaybookPorts` members against `slc/link.md`; CODE
      type-identity; all three `slc/*.md` resolve; `npm pack --dry-run`
      includes the `/runtime` artifacts and `slc/**`.
- [ ] Close-out re-verifies `map.md` and records any divergence.

## Tasks

Each task is one commit.
Order lands specs before behavior, adds the new surface additively
before refactoring CODE onto it, and publishes the slc specs last so
`main` builds and the test suite passes after every task.

1. **Land IR-015 + map.md row.** _[done]_
   Add this doc and its `map.md` row.
   No code or behavior change.
   Implementation note: committed as `2a773cd`.
2. **Spec amendments (prose only).** _[done]_
   Amend `slc/link.md` §Output and DR-004 §10 to record the shared
   `@sublang/playbook/runtime` source, the
   `PlaybookRuntimeFactory<Options = unknown>` contract, and that the
   emitted CODE module imports/re-exports the contract types.
   Relax PBRT-5 so the runtime module may import the shared runtime type
   contract in addition to the FSM artifact and XState, while still
   holding no host-specific types.
   Add RELEASE items marking `/runtime` and `slc/*` as public,
   semver-stable surfaces shipped via `files`/`exports`, with `/runtime`
   carrying only type-only contracts and consumers reading slc specs via
   `import.meta.resolve` + fs.
   Add PBRT dev/test items for the `slc/link.md` consistency check and
   the CODE type-identity check, and RELEASE test items for slc
   resolution and `npm pack` inclusion.
   Implementation note: `slc/link.md` adds `PlaybookRuntimeFactory<Options = unknown>`
   to the contract and a shared-source §Output bullet; DR-004 gains
   Addendum A4 with a §10 pointer and Status note; PBRT-5 relaxed and
   PBRT-34 added for the shared `@sublang/playbook/runtime` module;
   PBRT-35 (consistency vs `slc/link.md` + no CODE/FSM import) and
   PBRT-36 (CODE type-identity) added; RELEASE-15/16 (public `/runtime`
   and `slc/*` surfaces) and RELEASE-17/18 (slc resolution + `npm pack`
   inclusion) added; `map.md` decision/package summaries updated.
3. **Add `@sublang/playbook/runtime` (additive).** _[done]_
   Author `src/runtime.ts` with the four type-only contracts, commit its
   minimal valid `.js` and `.d.ts`, extend the `tsc` build to emit them,
   and extend the CI drift check to pin them.
   Add `exports['./runtime']` and the artifacts to `files`.
   Add tests for the downstream type import, the no-CODE/FSM transitive
   import guarantee, and the `slc/link.md` consistency check.
   CODE still uses its local definitions, so the suite stays green.
   Implementation note: `tsc` `include` extended to `src/*.ts`, emitting
   committed `src/runtime.js` (`export {}` + preserved SPDX header) and
   `src/runtime.d.ts`; CI drift glob, `package.json` `files`, and
   `exports['./runtime']` ({types, default}) wired; `vitest` `include`
   extended to `src/*.test.ts`. `src/runtime.test.ts` covers the
   `slc/link.md` consistency (PlayerResult.status + the four
   PlaybookPorts members), the four exported types, the standalone
   no-import guarantee, the `./runtime` export wiring, and ESM
   loadability (PBRT-35). PBRT-36 (CODE type-identity) is deferred to
   Task 4 because CODE still declares the types locally. Full suite
   green (714 tests).
4. **Refactor CODE onto the shared types + type-identity test.**
   Change `code.playbook.ts` to import `PlayerResult`, `PlaybookPorts`,
   and `PlaybookRuntime` from `@sublang/playbook/runtime` and re-export
   them, drop the local redefinitions, rebuild the `.js` / `.d.ts`
   siblings, and update the generation header/contract note.
   Wire test resolution for the self-referencing `@sublang/playbook`
   specifier.
   Add a type-identity test pinning the CODE-exported types to the shared
   ones, and keep every CODE runtime/conformance test green.
5. **Publish slc specs + resolution doc.**
   Add `slc/**` to `files` and `exports['./slc/*'] = './slc/*'`.
   Document in the README how to import the runtime contracts from
   `@sublang/playbook/runtime` and how to read `slc/link.md`,
   `slc/gears2fsm.md`, and `slc/text2gears.md` via
   `import.meta.resolve('@sublang/playbook/slc/<file>.md')` + fs.
   Add tests that all three `slc/*.md` resolve through the export and
   that `npm pack --dry-run` includes the `/runtime` artifacts and every
   `slc/**` file.
6. **Close-out.**
   Run the relevant test suite, re-verify `specs/map.md`, and record any
   substantive divergence from this IR.

## Acceptance criteria

- Downstream code imports `PlayerResult`, `PlaybookPorts`,
  `PlaybookRuntime`, and `PlaybookRuntimeFactory<Options = unknown>` from
  `@sublang/playbook/runtime`, which transitively imports no CODE or FSM
  types.
- `PlayerResult.status` and the four `PlaybookPorts` members in
  `src/runtime.ts` match `slc/link.md`, and a consistency check fails on
  drift.
- The committed CODE artifacts import/re-export the shared runtime types
  with no local redefinition, pinned by a type-identity test; the runtime
  engine stays emitted per artifact and no linker/engine export is added.
- `@sublang/playbook/slc/link.md`, `slc/gears2fsm.md`, and
  `slc/text2gears.md` all resolve, and the README documents the
  `import.meta.resolve` + fs reading pattern.
- `npm pack --dry-run` includes the `/runtime` artifacts and every
  `slc/**` file.
- `/runtime` and `slc/*` are recorded as public, semver-stable surfaces
  in the specs.
- The full test suite passes from the repo root.
