<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-068: Parallel Repository Observation Reads

## Status

Completed (2026-09-12).

## Intent

Reduce the existing repository observer's latency while preserving its complete projection and fail-closed receipt contract [[playbook-runtime-67](../packages/playbook-runtime.md#playbook-runtime-67)].
Retain the change only with measured improvement and the existing real Git integration matrix; this intent makes no model or whole-workflow performance claim.

## Deliverables

- [x] Concurrent independent Git reads within each observation sample, preserving both ordered full samples and existing error precedence.
- [x] Reproducible paired observation-and-receipt benchmark with exact implementation hashes and synthetic clean/dirty fixtures.
- [x] Reviewed timing evidence and passing real repository, cancellation, race, effect-ledger and deferred-checkpoint checks.

## Tasks

1. [x] Measure, review and commit the bounded observer change with its benchmark and results; preserve [[playbook-runtime-68](../packages/playbook-runtime.md#playbook-runtime-68)]'s observation cases and [[playbook-runtime-70](../packages/playbook-runtime.md#playbook-runtime-70)]'s durable-effect cases.

## Verification

The pinned `a000e37` private comparison used three warmup and twenty measured pairs for each clean/dirty-overlay and unchanged/one-commit combination.
Every full observation and receipt matched, with median paired savings of 134–153 ms and 79 wins in 80 pairs.
The private candidate passed all 85 cases in the existing repository-effects and public host-capabilities facade integration suites.
The maintained benchmark independently reproduced 116–133 ms median paired savings and 78 wins in 80 pairs, with every observation and receipt equal.
The integration candidate passes the same 85 real-Git cases in 39.15 seconds; two independent source reviews and the timing-evidence review found no actionable issue.
The [report and reproduction](../../scripts/experiments/repository-observation.md) and [sanitized paired evidence](../../scripts/experiments/repository-observation-evidence.json) retain the measured scope and exact identities.
Spex 3.0 reports zero errors with 233 existing advisory warnings, and all relative links resolve.
