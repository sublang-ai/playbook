<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-024: Run-defaults config

## Status

Done

## Intent

Implement DR-017: `playbook run` takes default player and captain agent specs from a top-level `run` block in the user config when flags are absent, so a tuned one-shot lineup no longer needs retyping on every invocation.

## Deliverables

- [x] `playbook run` resolves each required role as `--player` > `run.players.<role>` > `run.player` > `claude` and the captain as `--captain` > `run.captain` > `claude`, ignoring unrequired `run.players` roles and failing closed on a malformed `run` block, while `resume` keeps the stored lineup.
- [x] The launcher forwards its resolved or injected user-config path to the run host, and the config template documents a commented `run` block.
- [x] Acceptance tests pin the precedence chain, catch-all, ignore-unrequired, fail-closed, resume-immunity, and absent-file paths over a hermetic injected user-config path.
- [x] README, CHANGELOG, and `specs/map.md` document the feature.

## Tasks

1. **Author DR-017 and the spec surface.** _[done]_
   DR-017, this iteration, amended playbook-cli-19, and new playbook-cli-28/playbook-cli-29/playbook-cli-30 precede code changes.
2. **Load run defaults in the one-shot host.** _[done]_
   `loadRunDefaults` over the resolved user config in `bin/run.js`, the per-role and captain precedence chains in the first-run bind, launcher forwarding of the injected config path in `bin/playbook.js`, the amended run help text, and the template's commented `run` block.
3. **Pin acceptance tests.** _[done]_
   playbook-cli-30 clauses in `playbook.test.ts` over the injected agent factory and a hermetic injected user-config path, made standard for every run-path invocation so no test reads a developer's real config.

## Verification

- A config-only `run` block reaches the injected agent factory with its adapter, model, and effort; `run.player` covers every required role without a `run.players.<role>` entry; a `--player`/`--captain` flag beats the config default per role; `run.players.<role>` beats `run.player`.
- A `run.players` role the entry does not require is ignored; an absent file or missing `run` block keeps the `claude` defaults; an unsupported config effort exits `1` naming the supported values before any agent factory call; an unparseable file and a non-map `run` or `run.players` value each exit `1`.
- A resume rebuilds the parked lineup unchanged even when the config changed after parking.
- `pnpm test` and `pnpm build` pass.
