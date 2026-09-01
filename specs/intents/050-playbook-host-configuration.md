<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-050: Playbook host configuration

## Status

Incomplete

## Intent

Evolve the shared Playbook host configuration in three independently reviewable slices: adapter-scoped fast-mode tuning, automatic relocation of the irreplaceable user-authored config, and a proven starter agent lineup.
Keep authored SDLC workflow sources and their compiled artifacts outside this intent.

## Deliverables

- [ ] Fast mode is a complete adapter-scoped tuning dimension across configuration, host calls, durable execution projections, ordinary reopen, and uncertain retry.
- [ ] The user config resolves below `SPEX_HOME`, relocates safely from the former XDG path when needed, and composes deterministically with the retained profiles-content migration and starter seeding.
- [ ] The bundled starter config and public configuration documentation carry the requested Captain, Coder, and Reviewer lineup without changing notifications, enabled playbooks, or role bindings.
- [ ] Decision records, package behavior, integration verification, dependency metadata, and the full configured gate agree with the implementation without modifying excluded SDLC sources or compiled artifacts.

## Tasks

1. **Add adapter-scoped fast mode.**
   One commit: update the tuning decisions, affected spec-map summaries, and affected `playbook-cli`, `playbook-captain`, and `release` Behavior and Verification items before implementation; raise `@sublang/cligent` to `^0.24.0` with its lockfile update; thread `fastMode` through the normalized top-level Captain and player defaults, role overrides, exact `{ model, effort, fastMode, instruction, permissions }` call settings, Captain and player call construction, published runtime and declaration surfaces, launch-config resolution helpers, and durable key allowlists; treat it as the third tuning dimension excluded from structural and retained-generation envelope comparison but explicit in execution projections, refreshable on ordinary reopen, and byte-exact on uncertain retry; accept explicit `fastMode` only for `claude`, `claude-code`, and `codex` while rejecting it for `gemini`, `opencode`, and `kimi` before host work; and add focused integration and installed-dependency capability coverage while keeping [DR-015](../decisions/015-per-run-agent-tuning.md), [DR-032](../decisions/032-explicit-roles-session-players.md), and every affected package item synchronized.
2. **Relocate and migrate the user config.**
   One commit: add DR-043 for the deliberate user-authored-data migration exception and the relocation-before-content-migration order; add its decision-map row; update the config-path, seeding, migration, launch-pipeline, and Verification items in `playbook-cli`; resolve the primary path as `${SPEX_HOME:-$HOME/.spex}/playbook/playbook.config.yaml`; migrate an otherwise unshadowed former XDG-path file without clobbering, content or private-mode drift, or an interrupt-visible partial destination; emit exactly one stderr line naming both paths; seed only when neither path exists; retain the in-place profiles-content migration after relocation; update README and configuration documentation; and cover the path, composition, idempotence, permissions, interruption, and no-overwrite matrix through focused integration tests.
3. **Refresh the starter lineup.**
   One commit: update the starter-lineup Behavior and Verification items in `playbook-cli`, the bundled template, configuration documentation, and exact seed/template integration assertions so Captain is `claude` / `claude-opus-5` / `high` / auto, `dev.coder` is `codex` / `gpt-5.6-sol` / `ultra` / `fastMode: true` / auto with `writablePaths: ['.git']`, and `dev.reviewer` is `claude` / `claude-opus-5` / `xhigh` / auto, while leaving notifications, all three enabled playbooks, and every role binding unchanged.
4. **Run the final gate and close the intent.**
   One commit: after the preceding inputs settle, run `pnpm test` once, require no failures beyond the two pre-existing `code.gears-fsm.test.ts` source-to-artifact cases and one pre-existing `decide.gears-fsm.test.ts` case, record the exact evidence here, check every deliverable, mark this intent done, and leave the excluded authored SDLC sources and compiled artifacts untouched.

## Verification

- Config normalization, interactive composition, headless execution, Captain and delegated-player calls, durable reopen, and uncertain retry exercise fast mode through the installed Cligent surface and reject each unsupported adapter before registry preparation, import, readiness, or host work.
- Fresh, already-relocated, legacy-only, dual-path, interrupted, and retired-profiles inputs prove the config relocation is byte-preserving, private, no-clobber, idempotent, and ordered before the existing in-place content migration and fallback seeding.
- Parsing the bundled and newly seeded starter configs proves the exact requested agent blocks while notifications, enabled playbook modules, and role maps remain unchanged.
- `spex lint` reports no errors after every spec edit, and the final `pnpm test` run reports only the three named pre-existing source-to-artifact failures.
