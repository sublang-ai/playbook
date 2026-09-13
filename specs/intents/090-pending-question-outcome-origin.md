<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-090: Pending Question Outcome Origin

## Status

Complete.

## Intent

Restore an authored unchanged Boss question when its source state also permits a deferred question, preserving the canonical deferred operation and checkpoint protections.

## Deliverables

- [x] Clarify the selected question outcome's disposition and exact durable origin requirement.
- [x] Reuse current ledger ownership and persisted semantic reconciliation without changing the snapshot schema.
- [x] Verify both question outcomes and continuation modes with real-host integration controls.
- [x] Build and validate the focused runtime change for root review.

## Tasks

1. [x] Implement and verify exact pending-question origin discrimination with the existing deferred protections intact.

## Verification

- The private diagnostic at `/private/tmp/slc-question-origin-audit/run-complete/evidence.json`, SHA-256 `b8cf94e7759258c4ee8203f4dbd12f2505b654f2d7d99a79fc8b99611e3fff63`, matched all 12 expected outcomes without provider calls or changes to frozen compiler dependencies or original generated artifacts.
- `npm run build` passed and changed only the runtime's emitted JavaScript.
- `vitest run src/role-runtime-transition.test.ts src/xstate-playbook-runtime.test.ts --reporter=dot` passed all 296 tests in 8.55 seconds.
- `spex lint` passed with zero errors and the existing 253 warnings.
- `vitest run src/pending-question-origin.test.ts --reporter=verbose` passed all 11 real-host tests in 7.63 seconds, covering both outcomes with saved-token and fresh continuation, latest-owned-boundary selection, role and ownership mismatch, retained-text mismatch, open-operation precedence, changed checkpoints, and missing canonical operations.
- Root reviewed and approved the implementation, emitted-code scope, specification changes, and final real-host matrix before commit.
