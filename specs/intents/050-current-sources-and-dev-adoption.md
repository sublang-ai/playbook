<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-050: Recompile Maintained Workflows and Adopt DEV

## Status

Done — all artifacts, host adoption, and spec reconciliation landed with the full gates green

## Intent

Bring the compiled CODE, REVIEW, and DECIDE artifact sets into exact conformance with their current authored sources (updated through `fix(sdlc): name the IR and label relayed inputs` without recompilation), and adopt the DEV planning workflow per [DR-044](../decisions/044-dev-planning-workflow.md) with full host integration and verification.

## Deliverables

- [x] CODE, REVIEW, and DECIDE artifacts, registries, and conformance suites agree with their current sources under artifact schema 3.
- [x] `reference/sdlc/dev.playbook` exists: GEARS, FSM, linked runtime, registry, and conformance suites compiled from `reference/sdlc/dev.md`.
- [x] DEV host adoption: public `./dev/playbook` and `./dev/registry` subpaths, packaged files, seeded `dev.analyst` player, starter-config enablement, and documentation.
- [x] Package specs reconciled: the maintained-workflow enumerations and conformance items cover DEV and the recompiled shapes.
- [x] Full gates green: `npm test`, build, check-links, release surface checks.

## Tasks

1. [x] Record [DR-044](../decisions/044-dev-planning-workflow.md) and this ledger.
2. [x] Recompile the CODE artifact set and its conformance suites to the current source.
3. [x] Recompile the REVIEW artifact set and its conformance suites to the current source.
4. [x] Recompile the DECIDE artifact set and its conformance suites to the current source.
5. [x] Compile the DEV artifact set with its conformance suites.
6. [x] Wire DEV host adoption: exports, packaged files, starter config, launch validation, and docs.
7. [x] Reconcile the package specs with the recompiled shapes and the DEV adoption.

## Verification

- Per-directory conformance suites, `src/slc-source-contract.test.ts`, and `scripts/check-slc-source-gears.mjs` pass for all four workflows.
- The full `npm test` gate (Spex lint plus both Vitest passes), `npm run build`, and `npm run check:links` pass.
- Release-surface tests (`src/package-surface.test.ts`) accept the DEV subpaths and packaged files.
