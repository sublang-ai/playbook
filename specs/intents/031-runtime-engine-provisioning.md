<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-031: Run-Time Engine Provisioning

## Status

Done

## Intent

Implement [DR-024](../decisions/024-runtime-engine-provisioning.md): `playbook run` probes engine resolution from a filesystem `<from>` module and, when unresolvable, provisions `node_modules/xstate` and `node_modules/@sublang/playbook` beside it as symlinks to the running host's own packages — with `--no-provision`, the declared-manifest refusal, dangling-link handling, and the hermetic global-only acceptance case that re-scopes the [DR-023](../decisions/023-data-only-machine-ir.md) documentation gate.

## Deliverables

- [x] DR-024, new [[playbook-cli-36](../packages/playbook-cli.md#playbook-cli-36)]/[[playbook-cli-37](../packages/playbook-cli.md#playbook-cli-37)]/[[playbook-cli-38](../packages/playbook-cli.md#playbook-cli-38)], amended [[release-24](../packages/release.md#release-24)]/[[release-25](../packages/release.md#release-25)], this record, and the map rows.
- [x] The provisioning module wired into `bin/run.js` before `<from>` import on first runs and resume, with the `--no-provision` flag, the one-line provisioning log, the guard order, and injected host package roots.
- [x] Integration tests per playbook-cli-38 in the CLI suite, with zero existing expectations changed.
- [x] The fourth hermetic global-only acceptance scenario per release-25: isolated-prefix global install, thin fixture artifact, provisioning assertion, terminal envelope, idempotent second run, nested-cligent guard.

## Tasks

1. **Spec surface.** _[done]_ Author DR-024, playbook-cli-36/37/38, the release-24/25 amendments, this record, and the map rows.
2. **Provisioning with integration tests.** _[done]_ Add `bin/provision.js` (probe, guard order, symlink creation, log line), wire it into `bin/run.js` (`--no-provision` in `parseRunArgs`, call before `loadRegistryEntry` for filesystem specifiers on first runs and resume, injected host roots), extend `playbook.test.ts` per playbook-cli-38, and document the `.gitignore` recommendation in the CLI docs.
3. **Hermetic acceptance scenario.** _[done]_ Add the global-prefix install helper and the thin fixture artifact to the acceptance suite as the fourth sequential case per release-25.

## Verification

- From a bare directory, a globally installed `playbook run ./x.playbook.js` provisions two symlinks, logs one line naming them, and reaches its outcome; the identical second invocation provisions nothing and logs no provisioning line.
- A directory with a resolvable project-local engine is byte-identical after a run; `--no-provision` never creates links; a manifest declaring `@sublang/playbook` yields the instructive refusal with exit `1` and no agent call.
- A dangling provisioned link is replaced under default provisioning and named in a diagnostic under `--no-provision`; a real directory at a link path is never removed.
- `pnpm test` passes with no pre-existing expectation modified; the new acceptance case passes locally under `pnpm test:acceptance`.
