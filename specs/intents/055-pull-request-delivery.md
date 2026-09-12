<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-055: Pull-Request Delivery Through BRANCH and PR

## Status

In progress (started 2026-09-12).

## Intent

Adopt [DR-050](../decisions/050-pull-request-delivery.md): compile the new BRANCH and PR sources and the amended DEV source into maintained artifacts with their conformance suites, adopt them on the host surface, reconcile the package specs, and release the result so Spex can deliver a GitHub issue through `/dev` end to end.

## Deliverables

- [x] `reference/sdlc/branch.md`, `reference/sdlc/pr.md`, and the amended `reference/sdlc/dev.md` with DR-050 and this ledger.
- [ ] `reference/sdlc/branch.playbook` and `reference/sdlc/pr.playbook`: GEARS, FSM, linked runtime, registry, siblings, and conformance suites under artifact schema 3; PR's five mechanical items compiled as script states.
- [ ] `reference/sdlc/dev.playbook` recompiled to the amended source: two planning outcomes, the `branch` and `pr` calls, and their coverage.
- [ ] Host adoption: public `./branch/*` and `./pr/*` subpaths, packaged files, starter-config enablement, launch validation, release-surface pins, and documentation.
- [ ] Package specs reconciled: maintained-workflow enumerations and conformance items cover BRANCH, PR, and the six-outcome DEV.
- [ ] Release 13.2.0 published through the CI-gated workflow.

## Tasks

1. Record DR-050, the sources, and this ledger.
2. Compile the BRANCH artifact set with its conformance suites.
3. Compile the PR artifact set with its conformance suites.
4. Recompile the DEV artifact set and its conformance suites to the amended source.
5. Wire host adoption: exports, packaged files, starter config, launch validation, release-surface pins, CI sibling checks, and docs.
6. Reconcile the package specs with the new and recompiled shapes.
7. Prepare the 13.2.0 version and changelog commit and publish.

## Verification

- Per-directory conformance suites, `src/slc-source-contract.test.ts`, and `scripts/check-slc-source-gears.mjs` pass for all six workflows.
- `pnpm test`, `pnpm build`, `pnpm check:links`, and the compiled-sibling diff check pass.
- Release-surface tests accept the BRANCH and PR subpaths and packaged files.
