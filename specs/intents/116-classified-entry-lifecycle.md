<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-116: Classified Entry Lifecycle

## Status

Implemented; current public-main model-free integration verified.

## Intent

Honor classified initial events that require routing fields without losing terminal restart or carrying an earlier run's Boss exchanges into a new run, under [DR-019](../decisions/019-shared-linked-runtime-factory.md) and [DR-090](../decisions/090-every-role-hears-the-boss.md).

## Deliverables

- [x] Clarify classified entry lifecycle and its real-runtime verification.
- [x] Preserve classification and exact text while deriving entry identity from the initial parked state.
- [x] Verify fresh failure entry and terminal restart with fake ports and the real shared runtime, including refused-input and interrupt controls.
- [x] Rebuild shipped siblings and run local product checks.
- [x] Verify current public-main integration with its locked dependencies.

## Tasks

1. Specify and implement classified entry lifecycle with its regression and controls in one signed change.
2. Record verification and retain the original failure evidence.

## Verification

Current public-main integration on Playbook 17.11.0 with locked Cligent 0.36.0 passed frozen install, build, spec lint, the canonical test command, link checks and SPDX checks.
The main test segment passed 2,842 tests with 24 skips, including all 261 shared-runtime tests and the four classified-entry lifecycle controls; the separate capability segment passed 146 tests.
The build preserved compiled-sibling parity.
The existing selected-consumer four-case verification remains scoped to its exact dependency closure.

The earlier preserved candidate's broad run passed 2,822 tests and skipped 24, but one scaffolding case exceeded its unchanged 30-second deadline and three worker status-update RPCs timed out; that run remains failed.
That unchanged scaffolding case passed in isolation in 5.91 seconds, and the current integration's complete scaffolding file also passed without increasing its deadline.
No historical timeout cause is claimed from those later passes.
Release smoke and real-agent acceptance remain separate pre-tag gates under [[release-10](../packages/release.md#release-10)].
No provider calls or workflow execution is part of this product regression.
