<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-038: Conversational gate config coverage

## Goal

Bring the live gate's conversational config under the normal suite, the way
[PBCLI-32](../test/playbook-cli.md#pbcli-32) already covered its workflow one.

`acceptance/live-config.ts` exists so an ordinary `pnpm test` case can prove the
gate's config still composes.
[IR-036](036-session-scoped-conversational-captain.md)'s fifth (conversational)
scenario reintroduced the risk that file removes: its config and its two fixture
playbook sources were file-private to
`acceptance/playbook-live.acceptance.test.ts`, which is excluded from `pnpm test`
and CI.
A config-model change — the players shape, a reserved id, the registry-entry
contract — would break that scenario silently and surface only in a manual
pre-tag run, and that run is itself blocked on the unpublished cligent 0.19.0
(IR-036's one open deliverable), so nothing else would notice.

Scope is test placement and one new case.
No runtime, CLI, or published-surface change; `acceptance/` ships in no
package.

## Deliverables

- [x] `conversationConfig` moved into `acceptance/live-config.ts` beside
  `liveConfig` — both are top-level configs the gate writes, and the file's
  stated reason for existing is exactly this coverage.
- [x] `checklistFixtureSource` / `notesFixtureSource` moved into a new
  `acceptance/live-fixtures.ts` — generated playbook modules, not config, and
  ~300 lines of embedded JS that would bury the two config generators.
  Generated text is byte-identical; the acceptance suite imports both modules
  and is otherwise untouched.
- [x] A second PBCLI-32 case in
  `reference/sdlc/code.playbook/playbook.test.ts`: `conversationConfig`
  composed through the real `composeGenericConfig` over both fixture modules,
  written to the paths its `from` URLs name and imported by the real loader.
- [x] PBCLI-32 amended to cover both configs, keeping its released id per
  [META-12](../meta.md#meta-12).
- [x] This record and its `specs/map.md` row.

## Tasks

1. **Move the conversational fixtures out and cover them.** _[done]_
   One commit: the two `acceptance/` modules and the suite's imports, the new
   case, the PBCLI-32 amendment, this record, and the map row.
   No `CHANGELOG.md` entry — no published surface, command, or documented
   behavior changes, so [RELEASE-4](../dev/release.md#release-4) has nothing
   notable to record.
   Real fixture modules on disk rather than a stub loader — the stub would make
   the asserted ids and commands self-fulfilling, while importing the sources
   builds both machines and applies the runtime factory at module scope for
   about six lines of setup, reusing the temp-dir pattern the suite already
   uses for generated registry modules.

## Acceptance criteria

- The new case fails when the config model moves under the conversational
  config, verified by mutation: the generated `<id>-<role>` separator (both
  PBCLI-32 cases red), `RESERVED_CAPTAIN_ROLE_ID` retargeted to `worker` (only
  the new case red, since no workflow role is named `worker`), the checklist
  fixture's `command`, and a dangling transition target in the notes machine
  (each: only the new case red).
  Review added two more, both only-the-new-case red: the conversational
  config's own fixture `adapter`, and the notes fixture's manifest `id`
  (the manifest-id-equals-config-key path, distinct from the `command` one).
- Coverage boundary recorded in the case itself: a fixture's
  `@sublang/playbook/xstate-runtime` import resolves through the package
  export to the committed `src/*.js` sibling, so this case pins fixture drift
  against the released engine surface, not engine source drift — that stays
  the CI sibling drift check's job
  ([RELEASE-10](../dev/release.md#release-10)).
- The acceptance suite's behavior is unchanged: the moved sources differ only
  by their `export` keyword, and
  `vitest list --config vitest.acceptance.config.ts` still collects all five
  scenarios.
- `pnpm test` and `pnpm build` pass with no compiled-sibling drift, and
  `scripts/check-spdx.sh` and `scripts/check-links.mjs` are clean.
