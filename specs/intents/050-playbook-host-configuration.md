<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-050: Playbook host configuration

## Status

Incomplete

## Intent

Evolve the shared Playbook host configuration in three independently reviewable slices: adapter-scoped fast-mode tuning, automatic relocation of the irreplaceable user-authored config, and a proven starter agent lineup.
Keep authored SDLC workflow sources and their compiled artifacts outside this intent.

## Deliverables

- [ ] Fast mode is a Cligent-validated optional-boolean tuning dimension whose absent, explicit-false, and explicit-true states survive complete calls and durable execution, remain nonstructural, refresh on ordinary reopen, and persist exactly on uncertain retry.
- [ ] The user config resolves below `SPEX_HOME`, relocates safely from the former XDG path when needed, and defines relative-path rebasing, legacy-source retirement, interrupted dual-path precedence, namespace ownership, profiles-content migration, and fallback seeding explicitly.
- [ ] The bundled starter config and public configuration documentation carry the requested Captain, Coder, and Reviewer lineup without changing notifications, enabled playbooks, or role bindings.
- [ ] Decision records, package behavior, integration verification, dependency metadata, and the full configured gate agree with the implementation without modifying excluded SDLC sources or compiled artifacts.

## Tasks

1. **Specify fast-mode semantics.**
   One commit: amend every affected tuning and continuation decision, including [DR-015](../decisions/015-per-run-agent-tuning.md), [DR-021](../decisions/021-inline-agent-settings.md), [DR-027](../decisions/027-runtime-compatibility-from-cligent.md), [DR-032](../decisions/032-explicit-roles-session-players.md), and [DR-038](../decisions/038-universal-run-resumption.md), plus the relevant spec-map summaries and `playbook-cli`, `playbook-captain`, and `release` Behavior and Verification items; define top-level and role `fastMode` as a plain optional boolean with no tagged or role-level provider-default sentinel, top-level omission as provider default, role omission as inheritance, and `false` as a retained literal request; delegate adapter capability validation to the installed Cligent contract without a Playbook-owned support list; keep execution-projection schema `2` by adding only an optional own property whose absence remains canonical provider default; erase fast mode with model and effort when reproducing structure; exclude it from retained-generation envelope comparison; and specify current-config refresh on ordinary reopen, exact attempted-state reuse on uncertain retry, and the exact complete-call key surface before implementation.
2. **Implement and verify fast mode.**
   One commit: raise `@sublang/cligent` to `^0.24.0` with its lockfile update; thread optional `fastMode` through normalized Captain and player defaults, role overrides, `SessionAgent`, Captain and player call construction, published runtime and declaration surfaces, launch-config resolution helpers, execution projections, structural erasure, and durable optional-key allowlists while preserving explicit `false`; use Cligent's public capability assertion for every explicit request before host work; update configuration and CLI documentation, audit README, and correct the starter-template grammar commentary; and add focused integration, legacy-schema-2 absence, explicit-boolean, reopen, retry, retained-generation, dependency-surface, and installed-Cligent capability coverage, running the affected capability suite independently of the known full-suite blocker.
3. **Specify config relocation.**
   One commit: add DR-043 and its decision-map row, building on [DR-021](../decisions/021-inline-agent-settings.md)'s existing user-config migration precedent; update the affected `playbook-cli` and `release` Behavior and Verification items; assign Playbook ownership of the `playbook/` child below the shared `${SPEX_HOME:-$HOME/.spex}` root while leaving Spex-owned siblings untouched and the independently configurable sessions default under XDG state; require byte- and private-mode-preserving atomic no-clobber destination publication followed on normal success by legacy-path removal, with an interruption allowed to leave both complete files and the existing new path authoritative and neither file altered thereafter; preserve file bytes while deliberately rebasing relative `sessions` and filesystem `from` values to the new primary directory; and define the ordered pipeline as relocation, seeding only when neither canonical path exists, then the retained in-place profiles-content migration with its separate notice.
4. **Implement config relocation.**
   One commit: implement the shared `${SPEX_HOME:-$HOME/.spex}/playbook/playbook.config.yaml` resolver and interrupt-safe relocation before either front end reads config-dependent state; retain help and raw-config no-write boundaries; emit exactly one relocation stderr line naming both paths; cover new-only, legacy-only, neither, dual-path, publication and source-removal interruptions, exact bytes and mode, relative-path rebasing, profiles composition and notice order, and idempotence through focused integration tests; update README and configuration documentation; and update normal CLI helpers plus packed release-smoke, live-acceptance, and CI isolation harnesses to seed and select an isolated `SPEX_HOME` without masking real adapter authentication or accidentally exercising the legacy migration path.
5. **Refresh the starter lineup.**
   One commit: update the starter-lineup Behavior and Verification items in `playbook-cli`, the bundled template, configuration documentation, and exact seed/template integration assertions so Captain is `claude` / `claude-opus-5` / `high` / auto, `dev.coder` is `codex` / `gpt-5.6-sol` / `ultra` / `fastMode: true` / auto with `writablePaths: ['.git']`, and `dev.reviewer` is `claude` / `claude-opus-5` / `xhigh` / auto, while leaving notifications, all three enabled playbooks, and every role binding unchanged.
6. **Run the final gate and close the intent.**
   One commit: after the preceding inputs settle, run `pnpm test` once, require no new failure outside the six known source-to-artifact cases — three in `src/slc-source-contract.test.ts`, two in `reference/sdlc/code.playbook/code.gears-fsm.test.ts`, and one in `reference/sdlc/decide.playbook/decide.gears-fsm.test.ts` — record which of those cases still exist and the exact gate evidence here, check every deliverable, mark this intent done, and leave the excluded authored SDLC sources and compiled artifacts untouched rather than repairing their separate drift.

## Verification

- Config normalization, interactive composition, headless execution, Captain and delegated-player calls, durable reopen, and uncertain retry preserve absent, explicit-false, and explicit-true fast mode through the installed Cligent surface and delegate unsupported-adapter rejection before registry preparation, import, readiness, or host work.
- Existing execution-projection schema-2 data without fast mode remains canonical and reopenable, while explicit booleans survive execution projections and exact retry, structural projection erases fast mode, and retained-generation compatibility ignores it.
- Fresh, already-relocated, legacy-only, dual-path, interrupted, relative-locator, and retired-profiles inputs prove config relocation is byte-preserving, private, no-clobber, idempotent, source-retiring only after durable publication, explicit about new-path precedence and rebasing, isolated below `SPEX_HOME`, and ordered before fallback seeding and the existing in-place content migration.
- Parsing the bundled and newly seeded starter configs proves the exact requested agent blocks while notifications, enabled playbook modules, and role maps remain unchanged.
- `spex lint` reports no errors after every spec edit, and the final `pnpm test` run reports no failure outside the six enumerated pre-existing source-to-artifact cases.
