<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-011: playbook-code zero-config onboarding

## Goal

Reduce the fresh-user onboarding path to "install and run."
After `npm install -g @sublang/playbook` (or a one-shot `npx playbook-code`), invoking `playbook-code` shall seed a well-commented user config on first run, gate launch on a light per-adapter readiness check, and on failure print its own `--help` pointing at the seeded file and the per-adapter auth fixes.

The bundled production YAML stops being the runtime config and becomes the seed template; the runtime config lives in a stable user-level path so npx runs and `npm i -g` upgrades both behave correctly.

## Decisions baked in

- User config path: `${XDG_CONFIG_HOME:-$HOME/.config}/playbook/playbook-code.config.yaml`.
  Stable across global install and npx; never inside `node_modules`.
- The bundled `playbook-code.config.template.yaml` is comment-rich, names the PBRT-4 fixed-`id` invariant inline, and is the source of the seed.
- First run with the user config absent seeds it from the bundled template and writes a one-line stderr notice with the resolved path.
  Subsequent runs do not re-seed; the user owns the file across upgrades.
- `playbook-code --config <path>` bypasses seeding and the readiness check and exec-forwards as today, preserving the PBCODE-1 verbatim contract for that flag.
- Readiness check is light and vendor-specific over the YAML's declared adapter ids:
  `claude` is ready when `ANTHROPIC_API_KEY` is set or `$HOME/.claude/` exists;
  `codex` is ready when `OPENAI_API_KEY` is set or `$HOME/.codex/` exists;
  any other adapter id is skipped with a one-line stderr warning.
- Readiness failure prints `playbook-code --help` to stderr — config path, failing adapter(s), per-adapter auth/CLI pointers, and the swap recipe — and exits with a non-zero status distinct from PBCODE-2's `127`.
- `playbook-code --help` prints the same help text and exits `0` without launching.
- PBCODE-2's exit/signal forwarding still applies once the shim execs `tmux-play`.

## Deliverables

- [x] IR-011 doc and its `map.md` row landed.
- [x] [`specs/user/playbook-code.md`](../user/playbook-code.md) — PBCODE-1 amended so verbatim forwarding holds when `--config` is passed; PBCODE-5 (first-run seed) and PBCODE-6 (readiness gate + `--help`) added.
- [x] [`specs/dev/playbook-code.md`](../dev/playbook-code.md) — PBCODE-7 (template resolution from the package tree) and PBCODE-8 (readiness heuristic) added; PBCODE-3 reworded for the template-not-runtime-config role of the bundled YAML.
- [x] [`specs/test/playbook-code.md`](../test/playbook-code.md) — new test items covering seed-on-first-run, no-re-seed, `--config` bypass, readiness pass/fail per adapter, `--help` exit-code semantics.
- [x] [`reference/sdlc/code.playbook/playbook-code.config.template.yaml`](../../reference/sdlc/code.playbook/playbook-code.config.template.yaml) — new comment-rich template; the existing `tmux-play.production.config.yaml` is retained for the developer flow and the release smoke test.
- [x] [`reference/sdlc/code.playbook/bin/playbook-code.js`](../../reference/sdlc/code.playbook/bin/playbook-code.js) — seed, readiness, `--help`, and `--config` bypass; PBCODE-2 exit/signal semantics retained for the exec path.
- [x] [`reference/sdlc/code.playbook/playbook-code.test.ts`](../../reference/sdlc/code.playbook/playbook-code.test.ts) — new vitest covering the shim with mocked `HOME`, `XDG_CONFIG_HOME`, env vars, and spawn.
- [x] [`README.md`](../../README.md) — the `Configure agents` section is rewritten around the seeded file path and the `--help` recovery path; the `Install (users)` block names npx as a supported invocation.
- [x] [`package.json`](../../package.json) — `files` includes the new template; `bin` unchanged.
- [x] [`specs/map.md`](../map.md) — PBCODE rows refreshed and IR-011 row added.

## Tasks

Each task is one commit.
Order keeps `main` building and `pnpm test` green: spec amendments land first as a contract, the template ships before the shim depends on it, the shim and tests land together as the behavior cut-over, README and close-out follow.

1. **Land IR-011 + map.md row.**
   Add this IR doc and its `map.md` row.
   No code or behavior change.
2. **Spec amendments.**
   PBCODE user (PBCODE-1 reworded, PBCODE-5/PBCODE-6 added);
   PBCODE dev (PBCODE-3 reworded, PBCODE-7/PBCODE-8 added);
   PBCODE test items added;
   `specs/map.md` PBCODE summaries refreshed.
   All prose; no code touched.
3. **Template.**
   Add `playbook-code.config.template.yaml` with inline comments naming the PBRT-4 fixed-`id` invariant, the `adapter` swap knob, and the `captain.options` player-id pairing.
   Add the template path to `package.json` `files`.
   Existing tests stay green; the shim still points at the production YAML at this point.
4. **Shim + tests.**
   Implement seed/readiness/`--help`/`--config` bypass in `bin/playbook-code.js`;
   add `playbook-code.test.ts` covering seed-on-first-run, no-re-seed, `--config` bypass, readiness pass/fail for `claude` and `codex`, unknown-adapter warn-and-continue, and `--help` exit `0`.
   Land together so the shim change ships with its conformance.
5. **README + close-out.**
   Rewrite the README `Configure agents` section around the seeded path and the `--help` recovery flow;
   add `npx playbook-code` to `Install (users)`;
   re-verify `map.md`;
   record any substantive divergence from PBCODE specs as a one-line addendum.

## Acceptance criteria

- On a fresh install where `$HOME/.config/playbook/playbook-code.config.yaml` does not exist, `playbook-code` (with no flags) creates that file from the bundled template, writes a one-line stderr notice with its path, then continues to the readiness gate.
- `npx playbook-code` produces the same seeded file at the same user-level path, regardless of where the package itself was unpacked.
- With every adapter declared in the resolved YAML satisfying its readiness predicate, the shim execs cligent's `tmux-play` CLI against the user config; stdio is inherited and PBCODE-2 exit/signal forwarding holds.
- With any declared adapter not satisfying its predicate, the shim prints its `--help` to stderr — including the seeded config path, every failing adapter and its env-var/CLI alternative, and the swap recipe — and exits with a status that is non-zero and distinct from `127`.
- `playbook-code --help` prints that same help text to stdout and exits `0` without launching `tmux-play`.
- `playbook-code --config <path>` skips seeding and the readiness check and forwards verbatim, preserving PBCODE-1's contract for the explicit-flag path.
- A second invocation with the seeded file present does not modify or overwrite it.
- A YAML naming an adapter id other than `claude` or `codex` produces a one-line stderr warning and proceeds to launch; the readiness gate does not block.
- The seeded template's `roles[].id` lines carry an inline comment citing the PBRT-4 fixed-`id` invariant.
- `pnpm test` from the repo root is green and the new `playbook-code.test.ts` items pass.
- `specs/map.md` lists IR-011 and the updated PBCODE row summaries.
