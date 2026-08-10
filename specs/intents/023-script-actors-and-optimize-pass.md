<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-023: Script actors and the optimize pass

## Status

Done

## Intent

Codify [DR-016](../decisions/016-script-actors-and-optimize-pass.md) in the maintained pipeline definitions so slc compiles can rewrite mechanical GEARS items into agent-free script states.

## Deliverables

- [x] [DR-016](../decisions/016-script-actors-and-optimize-pass.md) and its `map.md` rows landed.
- [x] [`slc/text2gears.md`](../../slc/text2gears.md) — "Script behaviors (optimizer-introduced)": the `Captain shall run:` item form, static-blockquote rule, and fixed two-guard `Results:` contract.
- [x] [`slc/gears2fsm.md`](../../slc/gears2fsm.md) — the `script` actor kind, `ScriptInput`/`ScriptOutput` contracts, script-state declaration and mapping rules, and the agent-invoking exclusions (`needsBossReply`, resume registration).
- [x] [`slc/link.md`](../../slc/link.md) — "Script execution": linker-provided `sh -c` actor, `PlaybookRuntimeOptions.cwd`, mechanical guard mapping, abort handling, the `playbook.script` telemetry topic and status line, and the `node:child_process` output carve-out.
- [x] [`slc/optimize.md`](../../slc/optimize.md) — the new format-preserving gears → gears pass definition: eligibility, rewriting, provenance, and out-of-scope rules.
- [x] `package.json` ships `slc/optimize.md` through the existing `./slc/*` export.

## Tasks

1. Author the DR and register it in `map.md`.
2. Amend the three maintained definitions with the script-actor contracts.
3. Author `slc/optimize.md` and add it to the published file set.
4. Record the changes in `CHANGELOG.md`.

## Verification

- The four definitions agree on one script-item syntax: the literal `Captain shall run:` clause, a static blockquoted POSIX script, and exactly two exit-status guards in declared order.
- No change to `src/runtime.ts` or any published runtime artifact: the `script` actor is runtime-internal to emitted modules, and existing reference playbooks (CODE, DISCUSS, Captain) are untouched.
- A downstream slc compile that never requests optimization observes byte-identical definitions apart from the added sections.
