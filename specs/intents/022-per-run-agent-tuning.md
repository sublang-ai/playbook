<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-022: Per-run agent tuning

## Status

Done

## Intent

Implement DR-015: reasoning effort in the `playbook run` agent spec and repeatable `--with <path>` top-level config overlays for the interactive launch, so one run's lineup can differ from the global config without editing it.

## Deliverables

- [x] `playbook run` accepts `<adapter>[:<model>][@<effort>]` for `--player`/`--captain`, validates efforts against cligent's adapter-scoped support, forwards them to each `Cligent`, and stores/honors them across park and resume.
- [x] `playbook --with <path>` merges top-level config fragments over the resolved global config for composition, `--list`, and readiness, without forwarding the flag to tmux-play or touching the global file.
- [x] Acceptance tests pin the grammar, validation, resume round trip, overlay merge order, argv consumption, and conflict/error paths.
- [x] README, CHANGELOG, and `specs/map.md` document the feature.

## Tasks

1. **Author DR-015 and the spec surface.** _[done]_
   DR-015, this iteration, amended playbook-cli-19, and new playbook-cli-25/playbook-cli-26/playbook-cli-27 precede code changes.
2. **Extend the run host with effort.** _[done]_
   `@`-suffixed effort grammar in `bin/run.js`, adapter-scoped validation via cligent's effort metadata, `effort` on the default `Cligent` construction, and effort-bearing session records.
3. **Add `--with` overlays to the launcher.** _[done]_
   Flag parsing and argv consumption in `bin/playbook.js`, YAML fragment loading, recursive plain-map merge, and the `--config` conflict diagnostic.
4. **Pin acceptance tests.** _[done]_
   playbook-cli-27 clauses in `playbook.test.ts` over the injected agent factory, session store, and fake spawn.
5. **Document for fresh users.** _[done]_
   README run/launch sections, CHANGELOG entry, and `specs/map.md` rows.

## Verification

- `--player reviewer=codex:gpt-5.5@xhigh` reaches the injected agent factory with that model and effort; `--captain claude@high` sets effort with the default model; a colon-bearing model binds intact; an unsupported effort exits `1` naming the adapter's supported values before any agent runs.
- A parked session stores each spec's effort and a resume rebuilds the same lineup.
- `playbook --with <path>` launches with the fragment merged over the global config (plain maps recursively, other values replacing, argument order winning), leaves the global file byte-identical, and does not forward `--with` to tmux-play; `--list` reflects the merged config.
- `--with` plus `--config`, a missing or unparseable fragment, and a non-map fragment each exit `1` with a diagnostic.
- `pnpm test` and `pnpm build` pass.
