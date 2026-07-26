<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-030: Runtime Compatibility Metadata

## Goal

Implement [DR-022](../decisions/022-runtime-compatibility-contract.md): the engine's `RUNTIME_ABI` / `SUPPORTED_ARTIFACT_SCHEMAS` self-report, the optional `spec.compat` declaration checked fail-fast at `createXStatePlaybookRuntime` construction, the `slc/link.md` §Output link-time `compat` emission, and the `playbook run` diagnostic path for an incompatible artifact, and record the [DR-023](../decisions/023-data-only-machine-ir.md) data-only machine-IR direction.

## Deliverables

- [ ] DR-022 and DR-023, new [PBRT-50](../dev/playbook-runtime.md#pbrt-50) and [PBCLI-35](../test/playbook-cli.md#pbcli-35), amended [PBCLI-20](../dev/playbook-cli.md#pbcli-20) and [RELEASE-15](../dev/release.md#release-15), the `slc/link.md` §Output `compat` bullet, and the map rows.
- [ ] `RUNTIME_ABI`, `SUPPORTED_ARTIFACT_SCHEMAS`, and the `spec.compat` construction check in `src/xstate-playbook-runtime.ts` with regenerated committed `.js`/`.d.ts` siblings, pinned on the public engine surface.
- [ ] Factory unit tests for the compatible, schema-mismatch, ABI-mismatch, both-wrong, and absent-declaration paths, and a `playbook run` integration test over an incompatible synthetic entry, with zero existing expectations changed.
- [ ] Version 3.1.0 and the dated `[3.1.0]` CHANGELOG section per [RELEASE-4](../dev/release.md#release-4).

## Tasks

1. **Spec surface.** Author DR-022 and DR-023, add PBRT-50 and PBCLI-35, amend PBCLI-20, RELEASE-15, and `slc/link.md` §Output, and add this record and the map rows.
2. **Engine self-report and factory check with tests.** Add the exports, the `compat` spec member, and the construction-time check to `src/xstate-playbook-runtime.ts`; rebuild the committed siblings; extend the factory unit suite, the run-path suite, and the package-surface engine pin.
3. **Release preparation.** Bump `package.json` to 3.1.0 and cut the dated `[3.1.0]` CHANGELOG section with updated comparison links; do not tag.

## Acceptance criteria

- `createXStatePlaybookRuntime` with `compat: { artifactSchema: 1, runtimeAbi: 1 }` constructs; an unsupported `artifactSchema` throws a `TypeError` naming the declared schema and the supported set (also when the ABI is simultaneously wrong); a mismatched `runtimeAbi` throws a `TypeError` naming the declared and implemented values; an absent `compat` constructs unchanged.
- `playbook run` over a synthetic entry whose runtime construction declares incompatible metadata prints the `playbook run: <message>` diagnostic to stderr and exits `1` without calling any agent.
- `RUNTIME_ABI` and `SUPPORTED_ARTIFACT_SCHEMAS` resolve from `@sublang/playbook/xstate-runtime`.
- `pnpm test` passes with no pre-existing expectation modified, `pnpm build` leaves zero committed-sibling drift, `npx tsc --noEmit` is clean, and the git-ignored `pnpm-workspace.yaml` override is untouched.
