<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-029: Inline agent settings

## Goal

Implement [DR-021](../decisions/021-inline-agent-settings.md): remove the top-level `profiles` map and the agent-block `profile` key, inline the seeded lineup, and reject a profiles-bearing config with a migration diagnostic.

## Deliverables

- [x] PBCLI-4 drops `profiles` from the config model; a scalar agent value is an adapter shorthand only.
- [x] PBCLI-8 drops profile resolution and the collision rejection, and gains the migration rejection.
- [x] PBCLI-11 seeds the same lineup with inline settings and no `profiles` block.
- [x] `resolveAgent` takes no profiles map; the launcher rejects `profiles` and `profile` before composing.
- [x] Acceptance tests cover inline composition, the migration rejection, and the retired collision rule.
- [x] Template, README, CHANGELOG, and `specs/map.md` carry the inline model; the major version bumps.

## Tasks

1. **Author DR-021 and the spec surface.** _[done]_
   DR-021, this iteration, amended PBCLI-4/8/11, and the amended PBCLI-14/15 test items precede code changes.
2. **Simplify the launcher.** _[done]_
   `resolveAgent(value, path)` resolves a scalar as an adapter shorthand and an object as a self-contained agent block; a top-level `profiles` map or any agent-block `profile` key is rejected with a path-named migration diagnostic before composition.
3. **Inline the seeded template.** _[done]_
   `playbook.config.template.yaml` writes the Captain, Coder, and Reviewer settings under their own blocks with the lineup unchanged.
4. **Pin acceptance tests.** _[done]_
   Inline composition, the two migration rejections, and removal of the profile-collision and unresolvable-profile cases from PBCLI-15.
5. **Document and version.** _[done]_
   README config anatomy and the `--with` example, CHANGELOG breaking entry, `specs/map.md` rows, and the 3.0.0 bump.

## Acceptance criteria

- A config whose `captain` and `players.<role>` values are adapter shorthands or full inline blocks composes to the same tmux-play config the profile-based equivalent produced.
- A config carrying a top-level `profiles` map, or an agent block with a `profile` key, exits non-zero without launching and names the config path and the inline replacement.
- The seeded starter config contains no `profiles` block and still yields Captain `claude`/`claude-opus-4-8`@`high`, Coder `claude`/`claude-opus-4-8[1m]`@`xhigh`, Reviewer `codex`/`gpt-5.5`@`xhigh`, every agent in `permissions.mode: auto`, and the Codex role's `.git` writable path.
- The retired profile-id/adapter-shorthand collision and unresolvable-`profile` cases no longer appear in the validation suite.
- `pnpm test` and `pnpm build` pass.
