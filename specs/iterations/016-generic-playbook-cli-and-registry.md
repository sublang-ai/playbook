<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-016: Generic playbook CLI and registry enablement

## Goal

Implement [DR-009](../decisions/009-generic-playbook-cli-and-registry.md) in reviewable slices.

The end state is a generic `playbook` executable and a multi-playbook registry over the existing Playbook Captain shell.
Each enabled playbook is loaded from an explicit `from` module specifier, registered as a manifest entry, and configured through a top-level `profiles` map plus a `playbooks` map that the launcher normalizes into the shell's internal `captain.options.playbooks`.
Local runtime roles bind to playbook-scoped host players named `<id>.<role>`, every enabled playbook's generated players form a single launch-time tmux-play roster, and the shell drives tmux-play visibility so only the active playbook's panes are shown.
Park states and visible turn-summary policy become registry-entry-owned, so the shell no longer hardcodes CODE state ids such as `failed` or `awaitBossReply` or CODE-specific saved-count wording.
CODE is configured like any other playbook through `from: "@sublang/playbook/code/registry"`, its options slice is validated under `captain.options.playbooks.code.options`, and its Committer alias stays a CODE-owned option.

This is an intentional pre-1.0 breaking simplification per [DR-009 §1](../decisions/009-generic-playbook-cli-and-registry.md) and [DR-009 §6](../decisions/009-generic-playbook-cli-and-registry.md): the generic `playbook` command and one config model replace the CODE-specific launcher.
The `playbook-code` bin, the `@sublang/playbook/code/tmux-play` compatibility shim and export, the legacy `captain.options.code` host-config contract, and the entire PBCODE spec package are retired.
The single-active-engagement constraint, the free-text `handleBossInput` dispatch contract, the deferred `getSnapshot()`, and launcher-owned adapter readiness from DR-008 are preserved per [DR-009 §7](../decisions/009-generic-playbook-cli-and-registry.md).

### Out of scope

- Multiple concurrent parked engagements; the shell still supports one active engagement.
- Pre-engagement forms such as `playbook code "task"`, deferred in [DR-009 §6](../decisions/009-generic-playbook-cli-and-registry.md) until tmux-play exposes a clean initial Boss-turn injection surface.
- Pure Captain-only playbooks with no visible player, deferred in [DR-009 §4](../decisions/009-generic-playbook-cli-and-registry.md) until a host supports a zero-player visible state.
- A second shipped playbook; CODE remains the only registered entry, now loaded generically.
- `PlaybookRuntime.getSnapshot()` and any new in-playbook event API.

## Deliverables

- [ ] IR-016 doc and its `map.md` row.
- [x] CAPTAIN and PBRT spec amendments for registry-manifest entries, `from`-module enablement loaded from `captain.options.playbooks`, local-role-to-host-player binding, active-playbook visibility through tmux-play `setVisiblePlayers`, entry-owned `parkStateIds`, registry-owned optional summary policy, CODE identity derived from the active binding, CODE option validation against `captain.options.playbooks.code.options`, and removal of the `code/tmux-play` shim and `captain.options.code` contracts — with matching test-spec updates.
- [ ] New PBCLI user/dev/test spec package for the generic `playbook` launcher: config model, starter-config seeding, `from`-module loading and rejection rules, profile normalization, generated roster composition and binding, `layout.initialVisible`, active-playbook visibility switching, validation-rejection handling, display-only pane reconciliation, `--list`, `--config` pass-through, and adapter readiness.
- [ ] PBCODE user/dev/test specs retired; RELEASE and package-metadata specs amended for the breaking public-surface changes and the new `@sublang/playbook/code/registry` export; `map.md` package rows updated.
- [ ] CODE registry entry reshaped to the DR-009 §1 manifest, and the shell generalized to read park states, summary policy, and role binding from the active entry rather than hardcoding CODE specifics.
- [ ] Shell registry loading from `captain.options.playbooks` via explicit `from` modules, with duplicate-id / duplicate-command / missing-`from` / failed-import / invalid-entry rejection, namespaced `<id>.<role>` binding, and active-playbook `setVisiblePlayers` visibility.
- [ ] Generic `playbook` executable: profiles/playbooks normalization into `captain.options.playbooks`, generated namespaced roster and `layout.initialVisible`, starter-config seeding that enables CODE through `from`, adapter readiness, `--list`, and `--config` pass-through.
- [ ] Legacy surfaces removed: `playbook-code` bin and composer, `./code/tmux-play` shim/export, `captain.options.code` shell path, and legacy CODE tmux-play configs; `package.json` `bin`/`exports`/`files`, generated `.js`/`.d.ts` siblings, README, and CHANGELOG updated.
- [ ] Tests cover registry loading and rejection rules, namespaced binding, visibility switching including display-only reconciliation failures, entry-owned park states, registry-owned summary policy, CODE option validation under the new namespace, the generic launcher and starter seeding, and `--list`.
- [ ] Close-out re-verifies `map.md` and records any DR-009 divergence.

## Tasks

Each task is one commit.
Order lands specs before behavior, generalizes the shell and reshapes the CODE entry before introducing the new config contract, adds the generic launcher and the registry-loading path additively beside the legacy path so `main` builds and the suite passes after every task, and isolates the breaking removal of `playbook-code` / `code/tmux-play` / `captain.options.code` into a single late commit.

1. **Land IR-016 + map.md row.**
   Add this doc and its `map.md` Iterations row.
   No code or behavior change.

2. **Spec amendments: CAPTAIN + PBRT.** _[done]_
   Amend [CAPTAIN-5](../dev/playbook-captain.md#captain-5) so registry entries carry the DR-009 §1 manifest fields (`id`, `command`, `intent`, `requiredRoleIds`, `idleStateId`, `finalStateId`, `parkStateIds`, optional `summaryPolicy`, `validateOptions`, `createRuntime`) and the CODE entry declares `requiredRoleIds` `coder` / `reviewer`, `idleStateId: ready`, `finalStateId: done`, and `parkStateIds: [failed, awaitBossReply]`.
   Amend [CAPTAIN-10](../dev/playbook-captain.md#captain-10) for local-role-to-host-player binding at the port boundary and in `createRuntime` metadata, [CAPTAIN-11](../dev/playbook-captain.md#captain-11) to park from the entry's `idleStateId` and `parkStateIds` without hardcoded CODE state ids, and [CAPTAIN-16](../dev/playbook-captain.md#captain-16) to load enabled entries from `captain.options.playbooks`, reject missing enablement, and request active-playbook visibility.
   Amend [CAPTAIN-19](../user/playbook-captain.md#captain-19) and [CAPTAIN-20](../dev/playbook-captain.md#captain-20) so summary policy and saved-count wording are registry-owned and optional, and the shell skips the summary block when an entry declares no policy.
   Add CAPTAIN items for active-playbook visibility through tmux-play `setVisiblePlayers` (request the active playbook's generated player ids before dispatch, never request an empty set, treat a validation rejection as an internal error, and treat pane reconciliation failures as display-only and non-blocking).
   Amend [PBRT-15](../dev/playbook-runtime.md#pbrt-15) so CODE identity derivation uses the active role binding rather than raw `session.players` ids, [PBRT-30](../dev/playbook-runtime.md#pbrt-30) so CODE validates the `captain.options.playbooks.code.options` slice, and [PBRT-16](../dev/playbook-runtime.md#pbrt-16) / [PBRT-29](../user/playbook-runtime.md#pbrt-29) to remove the `@sublang/playbook/code/tmux-play` shim and legacy `captain.options.code` host-config contracts.
   Update the matching `test/playbook-captain.md` and `test/playbook-runtime.md` items and the `map.md` CAPTAIN / PBRT package rows.
   Prose only; no code.
   Implementation note: CAPTAIN-5 now defines the generic registry manifest (`id`, `command`, `intent`, `requiredRoleIds`, `idleStateId`, `finalStateId`, `parkStateIds`, optional `summaryPolicy`, `validateOptions`, `createRuntime`); CAPTAIN-10 adds the `<id>.<role>` binding at the port boundary and in `createRuntime` metadata; CAPTAIN-11 parks on the entry's `idleStateId` / `parkStateIds`; CAPTAIN-16 loads enabled entries from `captain.options.playbooks` via `from` with the duplicate-id / duplicate-command / failed-import / missing-enablement rejections; new CAPTAIN-22 owns active-playbook `setVisiblePlayers` visibility; CAPTAIN-19 / CAPTAIN-20 make the turn-summary policy registry-owned and optional. PBRT-4 / PBRT-15 derive identity from the bound host player and namespace players as `code.coder` / `code.reviewer`; PBRT-15 now declares CODE's full `summaryPolicy` (review/rebuttal labels, copy-paste guard names, and saved-counts line moved out of CAPTAIN-5 / CAPTAIN-19 / CAPTAIN-20); PBRT-30 validates the `captain.options.playbooks.code.options` slice; PBRT-8's alias reference was repointed; PBRT-16 / PBRT-29 drop the `code/tmux-play` shim and legacy `captain.options.code` contracts. Tests CAPTAIN-14 / CAPTAIN-15 / CAPTAIN-21 plus new CAPTAIN-23 and PBRT-21 / PBRT-31 updated; `map.md` CAPTAIN / PBRT rows refreshed. No code touched (PBCODE retirement and `code/registry` export land in Tasks 3 and 7).

3. **Spec: new PBCLI package + retire PBCODE + RELEASE/metadata.**
   Add the PBCLI user/dev/test package for the generic `playbook` launcher covering the top-level `profiles` / `playbooks` config model and its normalization into `captain.options.playbooks`, `from`-module loading and the rejection rules from [DR-009 §2](../decisions/009-generic-playbook-cli-and-registry.md) (missing `from`, failed import, invalid entry, duplicate id, duplicate effective command), profile-vs-adapter-shorthand collision rejection, generated namespaced roster composition and `<id>.<role>` binding validation, `layout.initialVisible` for the first enabled playbook, active-playbook visibility switching, validation-rejection handling, display-only pane reconciliation, starter-config seeding that enables CODE through `from`, adapter readiness, `--list`, `--config` pass-through, and the Node engine floor.
   Retire the PBCODE user/dev/test specs.
   Amend RELEASE so removal of the `playbook-code` bin, the `./code/tmux-play` export, and legacy CODE tmux-play configs are breaking public-surface changes under [RELEASE-1](../dev/release.md#release-1) / [RELEASE-4](../dev/release.md#release-4), add `@sublang/playbook/code/registry` as a public export, and confirm the [RELEASE-14](../dev/release.md#release-14) cligent range includes the tmux-play dynamic-visibility surface (`@sublang/cligent` 0.13.0).
   Swap the `map.md` PBCODE package row for a PBCLI row and update the RELEASE row.
   Prose only; no code.

4. **CODE registry manifest + shell entry-owned park / summary / binding.**
   Reshape the CODE registry entry to the DR-009 §1 manifest (`requiredRoleIds`, `idleStateId`, `finalStateId`, `parkStateIds`, `summaryPolicy` carrying the review/rebuttal labels and saved-counts template, `validateOptions` over the option slice, `createRuntime`).
   Generalize the shell to read park states, summary policy, and local-role-to-host-player binding from the active entry instead of hardcoding CODE state ids and wording.
   Keep the shell loading the single CODE entry from `captain.options.code` and registering CODE built-in for this task, so existing shell, compatibility-shim, and composer tests stay green; update tests for the manifest shape only.

5. **Shell registry loading from `captain.options.playbooks` (additive) + `./code/registry` export.**
   Add a shell enablement path that loads entries from `captain.options.playbooks` via explicit `from` modules, applies the rejection rules, binds local roles to `<id>.<role>` host players, passes each entry only its normalized option slice, and requests active-playbook visibility through tmux-play `setVisiblePlayers` on selection, resume, and routing.
   Add the public `@sublang/playbook/code/registry` module export for the CODE registry entry.
   Keep the legacy `captain.options.code` single-CODE path working in parallel so existing tests stay green; drive the new path in tests with hand-authored `captain.options.playbooks` configs, including duplicate-id / duplicate-command / failed-import rejection and display-only reconciliation failures.

6. **Generic `playbook` launcher.**
   Add the generic `playbook` executable that, without `--config`, reads the top-level config at `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook.config.yaml`, normalizes `profiles` and `playbooks` into `captain.options.playbooks`, compiles each playbook's `players` into the launch-time namespaced tmux-play roster, sets `layout.initialVisible` to the first enabled playbook's generated players, runs launcher-owned adapter readiness, and launches tmux-play targeting `@sublang/playbook/playbook-captain`.
   Seed a starter generic config that enables CODE through explicit `from` when the config is absent, reject profile ids that collide with adapter shorthands, and validate that every enabled playbook's required roles resolve to generated host player ids in the composed roster.
   Implement `playbook --list` (ids, effective commands, intents) and preserve `--config` pass-through of raw tmux-play configs.
   Add the PBCLI tests.

7. **Retire legacy surfaces + finalize metadata and docs.**
   Make `captain.options.playbooks` required and remove the legacy `captain.options.code` shell path per [DR-009 §3](../decisions/009-generic-playbook-cli-and-registry.md).
   Remove the `playbook-code` bin and composer, the `code.tmux-play` shim and its `./code/tmux-play` export, the bundled CODE overlay template, and the legacy CODE tmux-play configs and their tests.
   Update `package.json` `bin` (add `playbook`, drop `playbook-code`), `exports` (add `./code/registry`, drop `./code/tmux-play`), and `files`; regenerate the `.js` / `.d.ts` siblings; and update README and `CHANGELOG.md` `[Unreleased]` with the Added / Removed / Changed breaking entries.

8. **Close-out.**
   Run the relevant test suite, re-verify `specs/map.md`, and record any substantive divergence from DR-009 in this IR.

## Acceptance criteria

- A generic `playbook` executable, without `--config`, seeds a starter config that enables CODE through `from: "@sublang/playbook/code/registry"`, composes a tmux-play config whose `captain.from` is `@sublang/playbook/playbook-captain`, runs adapter readiness, and launches; with `--config` it passes a raw tmux-play config through unchanged.
- The shell loads every enabled playbook from `captain.options.playbooks` through its explicit `from` module and rejects missing `from`, failed imports, invalid entries, duplicate ids, and duplicate effective commands.
- The launcher normalizes top-level `profiles` / `playbooks` into `captain.options.playbooks`, generates one namespaced host player per playbook-local role bound as `<id>.<role>`, rejects profile ids colliding with adapter shorthands, and validates that every required role resolves to a generated roster id.
- The composed `layout.initialVisible` is the first enabled playbook's generated players, and on selection / resume / routing the shell requests that playbook's generated player ids through tmux-play `setVisiblePlayers`, never an empty set, with pane reconciliation failures non-blocking and a validation rejection surfaced as an internal error.
- Park states and visible turn-summary policy come from the active registry entry; the shell hardcodes no CODE state ids or CODE-specific saved-count wording and skips the summary block when an entry declares no policy.
- CODE derives its per-run identity strings from the active role binding, validates its options under `captain.options.playbooks.code.options`, and keeps the Committer alias as a CODE-owned option.
- The `playbook-code` bin, the `@sublang/playbook/code/tmux-play` export and shim, the `captain.options.code` host-config contract, and the PBCODE spec package are removed; `@sublang/playbook/code/registry` is a public export; and `map.md` reflects the package changes.
- `playbook --list` prints configured playbooks with their ids, effective commands, and intents.
- One active engagement is preserved: while a playbook is engaged, a different registered command asks Boss to finish, dismiss, or resolve the current engagement first.
- The full test suite passes from the repo root.
